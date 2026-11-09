import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { aiStatusSchema, isClosedTaskStatus, taskInputSchema, taskSchema, taskStatusSchema, type ScheduleEffect, type Task, type TaskStatus } from '../domain/task';
import { calculateSchedule } from '../domain/scheduling';
import { createScheduleTables, currentSchedule, ensureColumn, insertSchedule, stopTaskSchedules } from './schedule-records';

const taskRowSchema = z.object({
  id: z.string().uuid(), title: z.string(), description: z.string(), original_input: z.string(),
  deadline: z.string().nullable(), category: taskSchema.shape.category, task_type: taskSchema.shape.taskType,
  priority: taskSchema.shape.priority, ai_preparation_required: z.number(), status: taskSchema.shape.status,
  ai_status: taskSchema.shape.aiStatus, revision: z.number(), created_at: z.string(), updated_at: z.string(),
  deleted_at: z.string().nullable(), completed_at: z.string().nullable(), operation_key: z.string(),
});
type TaskRow = z.infer<typeof taskRowSchema>;
type StatusChangeResult = { task: Task; changed: boolean; scheduleEffect: ScheduleEffect };

export class TaskStatusError extends Error {
  constructor(readonly code: 'STATUS_CONFLICT', readonly task: Task) {
    super('別の画面でタスクの状態が変わりました。');
  }
}

export class TaskStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      original_input TEXT NOT NULL,
      deadline TEXT,
      category TEXT NOT NULL,
      task_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      ai_preparation_required INTEGER NOT NULL,
      status TEXT NOT NULL,
      ai_status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      completed_at TEXT,
      operation_key TEXT NOT NULL UNIQUE
    )`);
    ensureColumn(this.db, 'tasks', 'completed_at', 'TEXT');
    this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET completed_at = updated_at WHERE status = 'COMPLETED' AND completed_at IS NULL").run();
      this.db.prepare("UPDATE tasks SET completed_at = NULL WHERE status <> 'COMPLETED' AND completed_at IS NOT NULL").run();
    }).immediate();
    createScheduleTables(this.db);
  }

  create(rawInput: unknown, operationKey: string = randomUUID()): Task {
    const input = taskInputSchema.parse(rawInput);
    const existing = taskRowSchema.nullable().parse(this.db.prepare('SELECT * FROM tasks WHERE operation_key = ?').get(operationKey) ?? null);
    if (existing) return fromRow(existing);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO tasks (
      id, title, description, original_input, deadline, category, task_type, priority,
      ai_preparation_required, status, ai_status, revision, created_at, updated_at, deleted_at, operation_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, 1, ?, ?, NULL, ?)`)
      .run(id, input.title, input.description, input.originalInput, input.deadline, input.category,
        input.taskType, input.priority, Number(input.aiPreparationRequired), input.aiPreparationRequired ? 'WAITING_CONFIRMATION' : 'NOT_REQUIRED', now, now, operationKey);
    const task = this.get(id);
    if (!task) throw new Error('保存したタスクを取得できません。');
    return task;
  }

  list(): Task[] {
    const rows = z.array(taskRowSchema).parse(this.db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY deadline IS NULL, deadline, created_at DESC').all());
    return rows.map(fromRow);
  }

  get(id: string): Task | null {
    const row = taskRowSchema.nullable().parse(this.db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(id) ?? null);
    return row ? fromRow(row) : null;
  }

  changeStatus(id: string, rawStatus: TaskStatus, options: { expectedStatus?: TaskStatus; now?: Date } = {}): StatusChangeResult | null {
    return this.db.transaction((): StatusChangeResult | null => {
      const current = this.get(id);
      if (!current) return null;
      const status = taskStatusSchema.parse(rawStatus);
      const expectedStatus = options.expectedStatus === undefined ? undefined : taskStatusSchema.parse(options.expectedStatus);
      if (status === current.status) return { task: current, changed: false, scheduleEffect: 'NONE' };
      if (expectedStatus !== undefined && expectedStatus !== current.status) throw new TaskStatusError('STATUS_CONFLICT', current);
      const now = options.now ?? new Date();
      const wasClosed = isClosedTaskStatus(current.status);
      const closed = isClosedTaskStatus(status);
      let scheduleEffect: ScheduleEffect = 'NONE';
      if (!wasClosed && closed) {
        if (stopTaskSchedules(this.db, id) > 0) scheduleEffect = 'STOPPED';
      } else if (wasClosed && !closed) {
        scheduleEffect = this.restoreSchedule(id, now);
      }
      const aiStatus = wasClosed && !closed && current.aiStatus === 'CANCELLED'
        ? current.aiPreparationRequired ? 'WAITING_CONFIRMATION' : 'NOT_REQUIRED'
        : current.aiStatus;
      this.db.prepare('UPDATE tasks SET status = ?, completed_at = ?, ai_status = ?, revision = revision + ?, updated_at = ? WHERE id = ?')
        .run(status, status === 'COMPLETED' ? now.toISOString() : null, aiStatus, Number(wasClosed !== closed), now.toISOString(), id);
      const task = this.get(id);
      if (!task) throw new Error('変更したタスクを取得できません。');
      return { task, changed: true, scheduleEffect };
    }).immediate();
  }

  updateStatus(id: string, status: TaskStatus): Task | null {
    return this.changeStatus(id, status)?.task ?? null;
  }

  private restoreSchedule(id: string, now: Date): ScheduleEffect {
    const latest = currentSchedule(this.db, id);
    if (!latest) return 'NONE';
    const passed = latest.deadline !== null && Date.parse(latest.deadline) <= now.getTime();
    const hasPreparationJobs = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preparation_jobs'").get() !== undefined;
    this.db.prepare(`UPDATE task_schedules SET status = 'FAILED'
      WHERE task_id = ? AND status = 'RUNNING' AND deadline IS NOT NULL AND julianday(deadline) <= julianday(?)
      ${hasPreparationJobs ? `AND NOT EXISTS (SELECT 1 FROM preparation_jobs
        WHERE preparation_jobs.task_id = task_schedules.task_id
          AND preparation_jobs.operation_key = 'schedule:' || task_schedules.id)` : ''}`)
      .run(id, now.toISOString());
    if (latest.status === 'RUNNING' && passed) return 'DEADLINE_PASSED';
    if (latest.status === 'SCHEDULED' || latest.status === 'CANCELLED') {
      if (passed) {
        stopTaskSchedules(this.db, id);
        return 'DEADLINE_PASSED';
      }
      insertSchedule(this.db, id, calculateSchedule({ deadline: latest.deadline, now, estimatedAiMinutes: latest.estimatedAiMinutes, estimatedHumanMinutes: latest.estimatedHumanMinutes }));
      return 'RESCHEDULED';
    }
    if (latest.status === 'SUCCEEDED' || latest.status === 'RUNNING') {
      const notification = z.object({ status: z.string() }).nullable().parse(
        this.db.prepare('SELECT status FROM notifications WHERE schedule_id = ?').get(latest.id) ?? null);
      if (notification?.status === 'CANCELLED') {
        if (passed) return 'DEADLINE_PASSED';
        if (latest.deadline !== null) {
          this.db.prepare("UPDATE notifications SET status = 'SCHEDULED' WHERE schedule_id = ? AND status = 'CANCELLED'").run(latest.id);
          return 'NOTIFICATION_RESTORED';
        }
      }
    }
    return 'NONE';
  }

  updateAiStatus(id: string, aiStatus: Task['aiStatus']): Task | null {
    const validatedStatus = aiStatusSchema.parse(aiStatus);
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE tasks SET ai_status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(validatedStatus, now, id);
    return result.changes ? this.get(id) : null;
  }

  postpone(id: string, deadline: string | null): Task | null {
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE tasks SET deadline = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(deadline, now, id);
    return result.changes ? this.get(id) : null;
  }

  rename(id: string, title: string): Task | null {
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE tasks SET title = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(title, now, id);
    return result.changes ? this.get(id) : null;
  }

  delete(id: string): boolean {
    const now = new Date().toISOString();
    return this.db.prepare("UPDATE tasks SET status = 'CANCELLED', completed_at = NULL, ai_status = 'CANCELLED', deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(now, now, id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: TaskRow): Task {
  return taskSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    originalInput: row.original_input,
    deadline: row.deadline,
    category: row.category,
    taskType: row.task_type,
    priority: row.priority,
    aiPreparationRequired: Boolean(row.ai_preparation_required),
    status: row.status,
    aiStatus: row.ai_status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    completedAt: row.completed_at,
    syncStatus: 'PENDING_MOCK',
  });
}
