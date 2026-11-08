import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { scheduleRecordSchema, taskScheduleSchema, type TaskSchedule } from '../domain/scheduling';
import type { TaskStore } from './task-store';
import type { PreparationStore } from './preparation-store';

const scheduleRowSchema = z.object({
  id: z.string().uuid(), task_id: z.string().uuid(), revision: z.number().int(), deadline: z.string().nullable(),
  remind_at: z.string().nullable(), prepare_by: z.string(), review_by: z.string().nullable(), start_at: z.string(),
  immediate: z.number(), overdue: z.number(), estimated_ai_minutes: z.number(), estimated_human_minutes: z.number(),
  status: z.enum(['SCHEDULED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
});
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;

export class ScheduleStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_schedules (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, deadline TEXT, remind_at TEXT,
      prepare_by TEXT NOT NULL, review_by TEXT, start_at TEXT NOT NULL, immediate INTEGER NOT NULL,
      overdue INTEGER NOT NULL, estimated_ai_minutes INTEGER NOT NULL DEFAULT 30,
      estimated_human_minutes INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL, UNIQUE(task_id, revision)
    );
    CREATE INDEX IF NOT EXISTS task_schedule_queue ON task_schedules(status, start_at);
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, schedule_id TEXT NOT NULL UNIQUE, scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL, delivery_channel TEXT NOT NULL, mode TEXT NOT NULL, message TEXT NOT NULL
    );`);
    this.ensureColumn('task_schedules', 'estimated_ai_minutes', 'INTEGER NOT NULL DEFAULT 30');
    this.ensureColumn('task_schedules', 'estimated_human_minutes', 'INTEGER NOT NULL DEFAULT 60');
  }

  schedule(taskId: string, rawSchedule: TaskSchedule): ScheduleRecord {
    const schedule = taskScheduleSchema.parse(rawSchedule);
    const revision = this.db.prepare('SELECT MAX(revision) AS revision FROM task_schedules WHERE task_id = ?').get(taskId);
    const previous = z.object({ revision: z.number().nullable() }).parse(revision).revision ?? 0;
    const current = previous + 1;
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare("UPDATE notifications SET status = 'CANCELLED' WHERE schedule_id IN (SELECT id FROM task_schedules WHERE task_id = ? AND status = 'SCHEDULED')").run(taskId);
      this.db.prepare("UPDATE task_schedules SET status = 'CANCELLED' WHERE task_id = ? AND status = 'SCHEDULED'").run(taskId);
      this.db.prepare(`INSERT INTO task_schedules(id, task_id, revision, deadline, remind_at, prepare_by,
        review_by, start_at, immediate, overdue, estimated_ai_minutes, estimated_human_minutes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED')`)
        .run(id, taskId, current, schedule.deadline, schedule.remindAt, schedule.prepareBy, schedule.reviewBy,
          schedule.startAt, Number(schedule.immediate), Number(schedule.overdue), schedule.estimatedAiMinutes, schedule.estimatedHumanMinutes);
      if (schedule.remindAt) this.db.prepare(`INSERT INTO notifications(id, task_id, schedule_id, scheduled_at,
        status, delivery_channel, mode, message) VALUES (?, ?, ?, ?, 'SCHEDULED', 'IN_APP', 'mock', ?)`)
        .run(randomUUID(), taskId, id, schedule.remindAt, '締切前のモック通知です。タスクの準備状況を確認してください。');
    }).immediate();
    const record = this.get(id);
    if (!record) throw new Error('スケジュールを保存できません。');
    return record;
  }

  get(id: string): ScheduleRecord | null {
    const row = this.db.prepare('SELECT * FROM task_schedules WHERE id = ?').get(id);
    return row ? fromRow(scheduleRowSchema.parse(row)) : null;
  }

  current(taskId: string): ScheduleRecord | null {
    const row = this.db.prepare('SELECT * FROM task_schedules WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(taskId);
    return row ? fromRow(scheduleRowSchema.parse(row)) : null;
  }

  notifications(taskId: string): Array<{ status: string; mode: string; message: string; scheduledAt: string }> {
    const rows = z.array(z.object({ status: z.string(), mode: z.string(), message: z.string(), scheduled_at: z.string() }))
      .parse(this.db.prepare('SELECT status, mode, message, scheduled_at FROM notifications WHERE task_id = ? ORDER BY scheduled_at').all(taskId));
    return rows.map((row) => ({ status: row.status, mode: row.mode, message: row.message, scheduledAt: row.scheduled_at }));
  }

  async processDue(now: Date, tasks: TaskStore, preparations: PreparationStore): Promise<{ started: number; delivered: number }> {
    const currentTime = now.toISOString();
    const due = z.array(scheduleRowSchema).parse(this.db.prepare(`SELECT * FROM task_schedules
      WHERE status = 'SCHEDULED' AND julianday(start_at) <= julianday(?) ORDER BY start_at`).all(currentTime));
    let started = 0;
    for (const schedule of due) {
      const claim = this.db.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ? AND status = 'SCHEDULED'").run(schedule.id);
      if (!claim.changes) continue;
      const task = tasks.get(schedule.task_id);
      if (!task || ['COMPLETED', 'CANCELLED'].includes(task.status)) {
        this.db.prepare("UPDATE task_schedules SET status = 'CANCELLED' WHERE id = ?").run(schedule.id);
        continue;
      }
      if (task.aiPreparationRequired) preparations.enqueue(task, `schedule:${schedule.id}`);
      this.db.prepare("UPDATE task_schedules SET status = 'SUCCEEDED' WHERE id = ? AND status = 'RUNNING'").run(schedule.id);
      started += 1;
    }
    const reminders = z.array(z.object({ id: z.string().uuid(), task_id: z.string().uuid() })).parse(this.db.prepare(`SELECT notifications.id, notifications.task_id FROM notifications
      JOIN task_schedules ON task_schedules.id = notifications.schedule_id
      WHERE notifications.status = 'SCHEDULED' AND task_schedules.status != 'CANCELLED'
        AND julianday(notifications.scheduled_at) <= julianday(?)`).all(currentTime));
    const deliver = this.db.prepare("UPDATE notifications SET status = 'MOCK_DELIVERED', message = ? WHERE id = ? AND status = 'SCHEDULED'");
    for (const reminder of reminders) {
      const task = tasks.get(reminder.task_id);
      const message = task?.aiStatus === 'READY'
        ? '締切前のモック通知です。準備済みのドラフトを確認してください。'
        : '締切前のモック通知です。ドラフトは未完成の可能性があります。準備状況を確認してください。';
      deliver.run(message, reminder.id);
    }
    return { started, delivered: reminders.length };
  }

  close(): void { this.db.close(); }

  private ensureColumn(table: string, name: string, declaration: string): void {
    const columns = z.array(z.object({ name: z.string() })).parse(this.db.prepare(`PRAGMA table_info(${table})`).all());
    if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

function fromRow(row: z.infer<typeof scheduleRowSchema>): ScheduleRecord {
  return scheduleRecordSchema.parse({
    id: row.id, taskId: row.task_id, revision: row.revision, deadline: row.deadline,
    remindAt: row.remind_at, prepareBy: row.prepare_by, reviewBy: row.review_by, startAt: row.start_at,
    immediate: Boolean(row.immediate), overdue: Boolean(row.overdue), status: row.status,
    estimatedAiMinutes: row.estimated_ai_minutes, estimatedHumanMinutes: row.estimated_human_minutes,
  });
}
