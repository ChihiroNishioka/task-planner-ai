import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { TaskStore } from '../src/adapters/task-store';
import { ScheduleStore } from '../src/adapters/scheduling';
import { calculateSchedule } from '../src/domain/scheduling';
import { taskSchema } from '../src/domain/task';

const oldDdl = `CREATE TABLE tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, original_input TEXT NOT NULL,
 deadline TEXT, category TEXT NOT NULL, task_type TEXT NOT NULL, priority TEXT NOT NULL,
 ai_preparation_required INTEGER NOT NULL, status TEXT NOT NULL, ai_status TEXT NOT NULL,
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
 operation_key TEXT NOT NULL UNIQUE
)`;
const oldRowSchema = z.object({
 id: z.string().uuid(), title: z.string(), description: z.string(), original_input: z.string(), deadline: z.string().nullable(),
 category: taskSchema.shape.category, task_type: taskSchema.shape.taskType, priority: taskSchema.shape.priority,
 ai_preparation_required: z.number(), status: taskSchema.shape.status, ai_status: taskSchema.shape.aiStatus,
 revision: z.number(), created_at: z.string(), updated_at: z.string(), deleted_at: z.string().nullable(), operation_key: z.string(),
});
let directory: string; let path: string; let db: Database.Database;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'task-status-migration-')); path = join(directory, 'db.sqlite'); db = new Database(path); db.exec(oldDdl); });
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
function insert(status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') {
 const id = randomUUID();
 db.prepare(`INSERT INTO tasks (id,title,description,original_input,deadline,category,task_type,priority,ai_preparation_required,status,ai_status,revision,created_at,updated_at,deleted_at,operation_key)
 VALUES (?, '移行確認', '既存説明', '既存入力', NULL, 'PERSONAL', 'GENERAL', 'NORMAL', 0, ?, 'NOT_REQUIRED', 7, '2030-05-01T00:00:00.000Z', '2030-05-02T00:00:00.000Z', NULL, ?)`).run(id, status, randomUUID());
 return id;
}
function reopen() { const store = new TaskStore(path); store.close(); }
function rows() { return db.prepare('SELECT * FROM tasks ORDER BY id').all(); }

it('ST-M01 新しい動き: 旧DDLへ完了日時だけ追加し他列・revision・更新日時を維持する', () => {
 for (const status of ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const) insert(status);
 const before = z.array(oldRowSchema).parse(rows()); reopen();
 expect(rows()).toEqual(before.map(row => ({ ...row, completed_at: row.status === 'COMPLETED' ? row.updated_at : null })));
});
it('ST-M02 回帰の確認: 2回起動しても全行が同一', () => {
 insert('COMPLETED'); insert('OPEN'); reopen(); const first = rows(); reopen(); expect(rows()).toEqual(first);
});
it('ST-M03 新しい動き: 起動のたびに完了と完了日時の不整合を修復する', () => {
 const completed = insert('COMPLETED'); const open = insert('OPEN'); reopen();
 db.prepare('UPDATE tasks SET completed_at=NULL WHERE id=?').run(completed);
 db.prepare("UPDATE tasks SET completed_at='2030-05-03T00:00:00.000Z' WHERE id=?").run(open);
 const before = z.array(oldRowSchema).parse(rows()); reopen();
 expect(rows()).toEqual(before.map(row => ({ ...row, completed_at: row.status === 'COMPLETED' ? row.updated_at : null })));
});
function message(child: ChildProcess, expected: string) {
 return new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('子プロセス応答期限超過')), 4000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`子プロセス早期終了 ${code}`)); });
  child.once('message', value => { clearTimeout(timer); if (value === expected) resolve(); else reject(new Error('子プロセス応答不一致')); });
 });
}
it('ST-M04 新しい動き: 通常Shell専用、別プロセス2個の同時初期化で列追加は一度だけ', async () => {
 insert('COMPLETED'); db.pragma('journal_mode = WAL'); db.exec('BEGIN IMMEDIATE');
 let locked = true; const children: ChildProcess[] = [];
 try {
  for (let index = 0; index < 2; index++) children.push(fork(join(process.cwd(), 'tests/fixtures/task-status-migration-child.mjs'), [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 6000 }));
  const exits = children.map(child => once(child, 'exit'));
  await Promise.all(children.map(child => message(child, 'ready')));
  const starting = children.map(child => message(child, 'starting'));
  for (const child of children) child.send('go');
  await Promise.all(starting); await new Promise(resolve => setTimeout(resolve, 100));
  expect(children.map(child => child.exitCode)).toEqual([null, null]);
  db.exec('COMMIT'); locked = false;
  expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
  const columns = z.array(z.object({ name: z.string() })).parse(db.prepare('PRAGMA table_info(tasks)').all());
  expect(columns.filter(column => column.name === 'completed_at')).toHaveLength(1);
  expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status='COMPLETED' AND completed_at IS NULL").get()).toEqual({ count: 0 });
 } finally {
  if (locked) db.exec('ROLLBACK');
  for (const child of children) if (child.exitCode === null) child.kill();
 }
}, 10_000);
it('ST-M05 回帰の確認: 移行後も旧列指定INSERTと旧rowスキーマのSELECT解析ができる', () => {
 reopen(); const id = insert('OPEN');
 expect(oldRowSchema.parse(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))).toMatchObject({ id, status: 'OPEN' });
});
it('ST-M06 新しい動き: 空DBでもTaskStore単体で完了列と予定・通知表を作る', () => {
 db.exec('DROP TABLE tasks'); reopen();
 expect(z.array(z.object({ name: z.string() })).parse(db.prepare('PRAGMA table_info(tasks)').all()).map(column => column.name)).toContain('completed_at');
 const names = z.array(z.object({ name: z.string() })).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).map(table => table.name);
 expect(names).toEqual(expect.arrayContaining(['tasks', 'task_schedules', 'notifications']));
});
it('ST-M07 新しい動き: 旧版の完了・待機予定は移行で変えず未来時刻の再開で作り直す', () => {
 const id = insert('COMPLETED'); const schedules = new ScheduleStore(path);
 try {
  const schedule = calculateSchedule({ deadline: '2030-06-04T08:00:00.000Z', now: new Date('2030-06-01T00:00:00Z') });
  // 旧版が保存していた終了済み＋待機予定を、そのDDLの列指定で再現する。
  const scheduleId = randomUUID();
  db.prepare(`INSERT INTO task_schedules (id,task_id,revision,deadline,remind_at,prepare_by,review_by,start_at,immediate,overdue,estimated_ai_minutes,estimated_human_minutes,status) VALUES (?,?,1,?,?,?,?,?,0,0,30,60,'SCHEDULED')`)
   .run(scheduleId, id, schedule.deadline, schedule.remindAt, schedule.prepareBy, schedule.reviewBy, schedule.startAt);
  db.prepare("INSERT INTO notifications (id,task_id,schedule_id,scheduled_at,status,delivery_channel,mode,message) VALUES (?,?,?,?,'SCHEDULED','IN_APP','mock','移行前のモック通知')").run(randomUUID(), id, scheduleId, schedule.remindAt);
  const before = { schedules: db.prepare('SELECT * FROM task_schedules').all(), notifications: db.prepare('SELECT * FROM notifications').all() };
  const tasks = new TaskStore(path);
  try {
   expect(db.prepare('SELECT * FROM task_schedules').all()).toEqual(before.schedules); expect(db.prepare('SELECT * FROM notifications').all()).toEqual(before.notifications);
   expect(tasks.changeStatus(id, 'OPEN', { now: new Date('2030-06-01T00:00:00Z') })?.scheduleEffect).toBe('RESCHEDULED');
   expect(schedules.current(id)).toMatchObject({ revision: 2, status: 'SCHEDULED' }); expect(schedules.get(scheduleId)?.status).toBe('CANCELLED');
  } finally { tasks.close(); }
 } finally { schedules.close(); }
});
