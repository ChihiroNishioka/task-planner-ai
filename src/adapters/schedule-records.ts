import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { scheduleRecordSchema, type ScheduleRecord, type TaskSchedule } from '../domain/scheduling';

export const scheduleRowSchema = z.object({
  id: z.string().uuid(), task_id: z.string().uuid(), revision: z.number().int(), deadline: z.string().nullable(),
  remind_at: z.string().nullable(), prepare_by: z.string(), review_by: z.string().nullable(), start_at: z.string(),
  immediate: z.number(), overdue: z.number(), estimated_ai_minutes: z.number(), estimated_human_minutes: z.number(),
  status: scheduleRecordSchema.shape.status,
});

export function ensureColumn(db: Database.Database, table: string, name: string, declaration: string): void {
  const columns = z.array(z.object({ name: z.string() })).parse(db.prepare(`PRAGMA table_info(${table})`).all());
  if (columns.some(column => column.name === name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('duplicate column name'))) throw error;
  }
}

export function createScheduleTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_schedules (
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
  ensureColumn(db, 'task_schedules', 'estimated_ai_minutes', 'INTEGER NOT NULL DEFAULT 30');
  ensureColumn(db, 'task_schedules', 'estimated_human_minutes', 'INTEGER NOT NULL DEFAULT 60');
}

export function fromScheduleRow(row: z.infer<typeof scheduleRowSchema>): ScheduleRecord {
  return scheduleRecordSchema.parse({
    id: row.id, taskId: row.task_id, revision: row.revision, deadline: row.deadline,
    remindAt: row.remind_at, prepareBy: row.prepare_by, reviewBy: row.review_by, startAt: row.start_at,
    immediate: Boolean(row.immediate), overdue: Boolean(row.overdue), status: row.status,
    estimatedAiMinutes: row.estimated_ai_minutes, estimatedHumanMinutes: row.estimated_human_minutes,
  });
}

export function currentSchedule(db: Database.Database, taskId: string): ScheduleRecord | null {
  const row = db.prepare('SELECT * FROM task_schedules WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(taskId);
  return row ? fromScheduleRow(scheduleRowSchema.parse(row)) : null;
}

export function stopTaskSchedules(db: Database.Database, taskId: string): number {
  const schedules = db.prepare("UPDATE task_schedules SET status = 'CANCELLED' WHERE task_id = ? AND status = 'SCHEDULED'").run(taskId).changes;
  const notifications = db.prepare("UPDATE notifications SET status = 'CANCELLED' WHERE task_id = ? AND status = 'SCHEDULED'").run(taskId).changes;
  return schedules + notifications;
}

export function insertSchedule(db: Database.Database, taskId: string, schedule: TaskSchedule): ScheduleRecord {
  const previous = z.object({ revision: z.number().nullable() }).parse(
    db.prepare('SELECT MAX(revision) AS revision FROM task_schedules WHERE task_id = ?').get(taskId)).revision ?? 0;
  const revision = previous + 1;
  const id = randomUUID();
  db.prepare("UPDATE notifications SET status = 'CANCELLED' WHERE status = 'SCHEDULED' AND schedule_id IN (SELECT id FROM task_schedules WHERE task_id = ? AND status = 'SCHEDULED')").run(taskId);
  db.prepare("UPDATE task_schedules SET status = 'CANCELLED' WHERE task_id = ? AND status = 'SCHEDULED'").run(taskId);
  db.prepare(`INSERT INTO task_schedules(id, task_id, revision, deadline, remind_at, prepare_by,
    review_by, start_at, immediate, overdue, estimated_ai_minutes, estimated_human_minutes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED')`)
    .run(id, taskId, revision, schedule.deadline, schedule.remindAt, schedule.prepareBy, schedule.reviewBy,
      schedule.startAt, Number(schedule.immediate), Number(schedule.overdue), schedule.estimatedAiMinutes, schedule.estimatedHumanMinutes);
  if (schedule.remindAt) db.prepare(`INSERT INTO notifications(id, task_id, schedule_id, scheduled_at,
    status, delivery_channel, mode, message) VALUES (?, ?, ?, ?, 'SCHEDULED', 'IN_APP', 'mock', ?)`)
    .run(randomUUID(), taskId, id, schedule.remindAt, '締切前のモック通知です。タスクの準備状況を確認してください。');
  return scheduleRecordSchema.parse({ ...schedule, id, taskId, revision, status: 'SCHEDULED' });
}
