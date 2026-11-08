import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { aiStatusSchema, taskInputSchema, taskSchema, type Task } from '../domain/task';

const taskRowSchema = z.object({
  id: z.string().uuid(), title: z.string(), description: z.string(), original_input: z.string(),
  deadline: z.string().nullable(), category: taskSchema.shape.category, task_type: taskSchema.shape.taskType,
  priority: taskSchema.shape.priority, ai_preparation_required: z.number(), status: taskSchema.shape.status,
  ai_status: taskSchema.shape.aiStatus, revision: z.number(), created_at: z.string(), updated_at: z.string(),
  deleted_at: z.string().nullable(), operation_key: z.string(),
});
type TaskRow = z.infer<typeof taskRowSchema>;

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
      operation_key TEXT NOT NULL UNIQUE
    )`);
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

  updateStatus(id: string, status: Task['status']): Task | null {
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE tasks SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(status, now, id);
    return result.changes ? this.get(id) : null;
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
    return this.db.prepare("UPDATE tasks SET status = 'CANCELLED', ai_status = 'CANCELLED', deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
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
    syncStatus: 'PENDING_MOCK',
  });
}
