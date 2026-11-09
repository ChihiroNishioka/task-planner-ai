import Database from 'better-sqlite3';
import { z } from 'zod';
import { taskScheduleSchema, type TaskSchedule, type ScheduleRecord } from '../domain/scheduling';
import { isClosedTaskStatus, taskStatusSchema } from '../domain/task';
import type { TaskStore } from './task-store';
import { PreparationTaskNotRunnableError, type PreparationStore } from './preparation-store';
import { createScheduleTables, currentSchedule, fromScheduleRow, insertSchedule, scheduleRowSchema } from './schedule-records';

export type { ScheduleRecord } from '../domain/scheduling';

export class TaskNotActiveError extends Error {
  readonly code = 'TASK_NOT_ACTIVE';
  constructor() {
    super('完了・中止したタスクには期限と通知を設定できません。再開してから設定してください。');
  }
}

export class ScheduleStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    createScheduleTables(this.db);
  }

  schedule(taskId: string, rawSchedule: TaskSchedule): ScheduleRecord {
    const schedule = taskScheduleSchema.parse(rawSchedule);
    return this.db.transaction(() => {
      if (!this.activeTask(taskId)) throw new Error('タスクが見つかりません。');
      return insertSchedule(this.db, taskId, schedule);
    }).immediate();
  }

  scheduleForActiveTask(taskId: string, rawSchedule: TaskSchedule, date: string | null): ScheduleRecord | null {
    const schedule = taskScheduleSchema.parse(rawSchedule);
    return this.db.transaction(() => {
      if (!this.activeTask(taskId)) return null;
      this.db.prepare('UPDATE tasks SET deadline = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(date, new Date().toISOString(), taskId);
      return insertSchedule(this.db, taskId, schedule);
    }).immediate();
  }

  private activeTask(taskId: string): boolean {
    const task = z.object({ status: taskStatusSchema, deleted_at: z.string().nullable() }).nullable().parse(
      this.db.prepare('SELECT status, deleted_at FROM tasks WHERE id = ?').get(taskId) ?? null);
    if (!task || task.deleted_at) return false;
    if (isClosedTaskStatus(task.status)) throw new TaskNotActiveError();
    return true;
  }

  get(id: string): ScheduleRecord | null {
    const row = this.db.prepare('SELECT * FROM task_schedules WHERE id = ?').get(id);
    return row ? fromScheduleRow(scheduleRowSchema.parse(row)) : null;
  }

  current(taskId: string): ScheduleRecord | null {
    return currentSchedule(this.db, taskId);
  }

  notifications(taskId: string): Array<{ status: string; mode: string; message: string; scheduledAt: string }> {
    const rows = z.array(z.object({ status: z.string(), mode: z.string(), message: z.string(), scheduled_at: z.string() }))
      .parse(this.db.prepare('SELECT status, mode, message, scheduled_at FROM notifications WHERE task_id = ? ORDER BY scheduled_at').all(taskId));
    return rows.map((row) => ({ status: row.status, mode: row.mode, message: row.message, scheduledAt: row.scheduled_at }));
  }

  async processDue(now: Date, tasks: TaskStore, preparations: PreparationStore): Promise<{ started: number; delivered: number }> {
    const currentTime = now.toISOString();
    const claimed = this.db.transaction(() => {
      const due = z.array(scheduleRowSchema).parse(this.db.prepare(`SELECT * FROM task_schedules
        WHERE status = 'SCHEDULED' AND julianday(start_at) <= julianday(?) ORDER BY start_at`).all(currentTime));
      return due.filter(schedule => {
        const task = z.object({ status: taskStatusSchema, deleted_at: z.string().nullable() }).nullable().parse(
          this.db.prepare('SELECT status, deleted_at FROM tasks WHERE id = ?').get(schedule.task_id) ?? null);
        if (!task || task.deleted_at || isClosedTaskStatus(task.status)) {
          this.cancelSchedule(schedule.id, now);
          return false;
        }
        this.db.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ? AND status = 'SCHEDULED'").run(schedule.id);
        return true;
      });
    }).immediate();
    let started = 0;
    for (const schedule of claimed) {
      const task = tasks.get(schedule.task_id);
      if (!task || isClosedTaskStatus(task.status)) {
        this.cancelSchedule(schedule.id, now);
        continue;
      }
      try {
        if (task.aiPreparationRequired) preparations.enqueue(task, `schedule:${schedule.id}`);
      } catch (error) {
        if (!(error instanceof PreparationTaskNotRunnableError)) throw error;
        this.cancelSchedule(schedule.id, now);
        continue;
      }
      this.db.prepare("UPDATE task_schedules SET status = 'SUCCEEDED' WHERE id = ? AND status = 'RUNNING'").run(schedule.id);
      started += 1;
    }
    this.db.prepare(`UPDATE notifications SET status = 'CANCELLED'
      WHERE status = 'SCHEDULED' AND (
        NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = notifications.task_id
          AND tasks.deleted_at IS NULL AND tasks.status IN ('OPEN', 'IN_PROGRESS'))
        OR EXISTS (SELECT 1 FROM task_schedules WHERE task_schedules.id = notifications.schedule_id AND task_schedules.status = 'CANCELLED'))`).run();
    const delivered = this.db.prepare(`UPDATE notifications SET status = 'MOCK_DELIVERED', message = CASE
      WHEN EXISTS (SELECT 1 FROM tasks WHERE tasks.id = notifications.task_id AND tasks.ai_status = 'READY')
      THEN CASE WHEN EXISTS (SELECT 1 FROM artifacts WHERE artifacts.task_id = notifications.task_id)
        THEN '締切前のモック通知です。準備済みのドラフトを確認してください。'
        ELSE '締切前のモック通知です。分解ができています。ドラフトを作って確認してください。' END
      ELSE '締切前のモック通知です。ドラフトは未完成の可能性があります。準備状況を確認してください。' END
      WHERE status = 'SCHEDULED' AND julianday(scheduled_at) <= julianday(?)
        AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = notifications.task_id
          AND tasks.deleted_at IS NULL AND tasks.status IN ('OPEN', 'IN_PROGRESS'))
        AND EXISTS (SELECT 1 FROM task_schedules WHERE task_schedules.id = notifications.schedule_id AND task_schedules.status <> 'CANCELLED')`)
      .run(currentTime).changes;
    return { started, delivered };
  }

  private cancelSchedule(id: string, now: Date): void {
    this.db.transaction(() => {
      const schedule = this.get(id);
      if (!schedule) return;
      const task = z.object({ status: taskStatusSchema, deleted_at: z.string().nullable(), updated_at: z.string() }).nullable().parse(
        this.db.prepare('SELECT status, deleted_at, updated_at FROM tasks WHERE id = ?').get(schedule.taskId) ?? null);
      if (task && !task.deleted_at && !isClosedTaskStatus(task.status)) {
        const passed = schedule.deadline !== null && Date.parse(schedule.deadline) <= Math.max(now.getTime(), Date.parse(task.updated_at));
        this.db.prepare("UPDATE task_schedules SET status = ? WHERE id = ? AND status = 'RUNNING'")
          .run(passed ? 'FAILED' : 'SCHEDULED', id);
        return;
      }
      this.db.prepare("UPDATE task_schedules SET status = 'CANCELLED' WHERE id = ? AND status IN ('SCHEDULED', 'RUNNING')").run(id);
      this.db.prepare("UPDATE notifications SET status = 'CANCELLED' WHERE schedule_id = ? AND status = 'SCHEDULED'").run(id);
    }).immediate();
  }

  close(): void { this.db.close(); }
}
