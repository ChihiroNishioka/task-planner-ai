import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/adapters/task-store';
import { ScheduleStore } from '../src/adapters/scheduling';
import { PreparationStore } from '../src/adapters/preparation-store';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { MockAiAdapter } from '../src/adapters/mock-ai';
import { calculateSchedule } from '../src/domain/scheduling';
import { aiStatusLabel, jobStatusLabel, statusLabel, statusChangeMessage } from '../src/domain/labels';
import type { Task } from '../src/domain/task';

const now = new Date('2030-06-01T00:00:00.000Z');
const deadline = '2030-06-04T08:00:00.000Z';
const statuses = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] satisfies Task['status'][];
let directory: string;
let path: string;
let tasks: TaskStore;
let schedules: ScheduleStore;
let preparations: PreparationStore;
let breakdown: BreakdownStore;
let db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'task-status-'));
  path = join(directory, 'db.sqlite');
  tasks = new TaskStore(path);
  schedules = new ScheduleStore(path);
  preparations = new PreparationStore(path, join(directory, 'artifacts'));
  breakdown = new BreakdownStore(path);
  db = new Database(path);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close(); breakdown.close(); preparations.close(); schedules.close(); tasks.close();
  rmSync(directory, { recursive: true, force: true });
});
function create(aiPreparationRequired = false) { return tasks.create({ title: '状態変更の確認', aiPreparationRequired }); }
function change(id: string, status: Task['status']) { return tasks.changeStatus(id, status, { now }); }
function schedule(id: string, value: string | null = deadline) { return schedules.schedule(id, calculateSchedule({ deadline: value, now, estimatedAiMinutes: 45, estimatedHumanMinutes: 90 })); }
function rows(table: 'tasks' | 'task_schedules' | 'notifications' | 'preparation_jobs') { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
function rawStatus(id: string, status: Task['status']) { db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id); }

it('ST-U01 新しい動き: 全12遷移で状態と完了日時を保存する', () => {
  for (const from of statuses) for (const to of statuses) {
    if (from === to) continue;
    const task = create();
    rawStatus(task.id, from);
    const result = change(task.id, to);
    expect(result).toMatchObject({ changed: true, task: { status: to, completedAt: to === 'COMPLETED' ? now.toISOString() : null } });
    expect(tasks.get(task.id)).toMatchObject({ status: to, completedAt: to === 'COMPLETED' ? now.toISOString() : null });
  }
});
it('ST-U02 新しい動き: 同状態は日時とrevisionを変えない', () => {
  for (const status of statuses) {
    const task = create(); change(task.id, status);
    const before = tasks.get(task.id);
    expect(tasks.changeStatus(task.id, status, { now: new Date('2030-06-02T00:00:00Z') })).toMatchObject({ changed: false, scheduleEffect: 'NONE', task: before });
    expect(tasks.get(task.id)).toEqual(before);
  }
});
it('ST-U03 新しい動き: 別接続の変更を古いexpectedStatusで上書きしない', () => {
  const task = create(); const other = new TaskStore(path);
  try { other.changeStatus(task.id, 'COMPLETED', { now }); } finally { other.close(); }
  const before = rows('tasks');
  expect(() => tasks.changeStatus(task.id, 'IN_PROGRESS', { now, expectedStatus: 'OPEN' })).toThrow(expect.objectContaining({ code: 'STATUS_CONFLICT' }));
  expect(rows('tasks')).toEqual(before);
});
it('ST-U04 回帰の確認: 削除済みタスクを戻さず行を変えない', () => {
  const task = create(); tasks.delete(task.id); const before = rows('tasks');
  expect(tasks.updateStatus(task.id, 'OPEN')).toBeNull();
  expect(rows('tasks')).toEqual(before);
});
it('ST-U05 新しい動き: 生成中の進行系切替は分解を保存し終了・再開だけrevisionを上げる', async () => {
  const task = create();
  breakdown.mutate(task.id, { action: 'regenerate', baseVersion: null, requestKey: 'generate', steps: [], comment: '整理する' });
  const result = await breakdown.runNext(tasks, preparations, { generate: t => new MockAiAdapter().generate(t), breakdown: async t => {
    const revision = tasks.get(task.id)!.revision;
    change(task.id, 'IN_PROGRESS'); expect(tasks.get(task.id)!.revision).toBe(revision);
    return new MockAiAdapter().breakdown(t, ['確認する'], '整理する');
  } });
  expect(result?.status).toBe('SUCCEEDED');
  const revision = tasks.get(task.id)!.revision;
  change(task.id, 'COMPLETED'); expect(tasks.get(task.id)!.revision).toBe(revision + 1);
  change(task.id, 'CANCELLED'); expect(tasks.get(task.id)!.revision).toBe(revision + 1);
  change(task.id, 'OPEN'); expect(tasks.get(task.id)!.revision).toBe(revision + 2);
});
it('ST-U06 新しい動き: 完了で待機予定・通知を停止し実行履歴は守る', () => {
  const task = create(); const first = schedule(task.id);
  db.prepare("UPDATE task_schedules SET status='SUCCEEDED' WHERE id=?").run(first.id);
  db.prepare("UPDATE notifications SET status='MOCK_DELIVERED' WHERE schedule_id=?").run(first.id);
  const second = schedule(task.id);
  expect(change(task.id, 'COMPLETED')?.scheduleEffect).toBe('STOPPED');
  expect(schedules.get(first.id)?.status).toBe('SUCCEEDED'); expect(schedules.get(second.id)?.status).toBe('CANCELLED');
  expect(schedules.notifications(task.id).map(n => n.status)).toEqual(['MOCK_DELIVERED', 'CANCELLED']);
});
it('ST-U07 新しい動き: 実行済み予定の未配信通知も完了で止まる', async () => {
  const task = create(); const record = schedule(task.id);
  db.prepare("UPDATE task_schedules SET status='SUCCEEDED' WHERE id=?").run(record.id);
  expect(change(task.id, 'COMPLETED')?.scheduleEffect).toBe('STOPPED');
  expect((await schedules.processDue(new Date(deadline), tasks, preparations)).delivered).toBe(0);
  expect(schedules.notifications(task.id)[0]?.status).toBe('CANCELLED');
});
it('ST-U08 新しい動き: 未来締切の停止予定を見積りと期限を保って新revisionで再開する', () => {
  const task = create(true); const old = schedule(task.id); change(task.id, 'COMPLETED');
  expect(schedules.get(old.id)?.status).toBe('CANCELLED');
  const revision = tasks.get(task.id)!.revision;
  expect(change(task.id, 'OPEN')).toMatchObject({ scheduleEffect: 'RESCHEDULED', task: { revision: revision + 1 } });
  expect(schedules.current(task.id)).toMatchObject({ revision: 2, status: 'SCHEDULED', deadline, estimatedAiMinutes: 45, estimatedHumanMinutes: 90 });
  expect(schedules.get(old.id)?.status).toBe('CANCELLED');
  expect(schedules.notifications(task.id).map(n => n.status)).toEqual(['CANCELLED', 'SCHEDULED']);
});
it('ST-U09 新しい動き: 通知時刻後の再開でも準備と通知は一度だけ', async () => {
  const task = create(true); schedule(task.id); change(task.id, 'COMPLETED');
  const late = new Date('2030-06-03T06:00:00Z');
  expect(tasks.changeStatus(task.id, 'OPEN', { now: late })?.scheduleEffect).toBe('RESCHEDULED');
  const first = await schedules.processDue(late, tasks, preparations);
  const second = await schedules.processDue(late, tasks, preparations);
  expect(first).toEqual({ started: 1, delivered: 1 }); expect(second).toEqual({ started: 0, delivered: 0 });
  expect(rows('preparation_jobs')).toHaveLength(1);
});
it('ST-U10 新しい動き: 締切が過去または同時刻なら再作成しない', () => {
  for (const at of [deadline, '2030-06-05T00:00:00Z']) {
    const task = create(); schedule(task.id); change(task.id, 'COMPLETED');
    expect(tasks.changeStatus(task.id, 'OPEN', { now: new Date(at) })?.scheduleEffect).toBe('DEADLINE_PASSED');
    expect(schedules.current(task.id)).toMatchObject({ revision: 1, status: 'CANCELLED' });
  }
});
it('ST-U11 新しい動き: 締切なしの停止予定も通知なしで再開する', () => {
  const task = create(); schedule(task.id, null); change(task.id, 'CANCELLED');
  expect(change(task.id, 'IN_PROGRESS')?.scheduleEffect).toBe('RESCHEDULED');
  expect(schedules.current(task.id)).toMatchObject({ revision: 2, remindAt: null, deadline: null, status: 'SCHEDULED' });
  expect(schedules.notifications(task.id)).toEqual([]);
});
it('ST-U12 新しい動き: 実行済み予定は既存通知だけ復帰し締切後は戻さない', () => {
  for (const future of [true, false]) {
    const task = create(); const record = schedule(task.id);
    db.prepare("UPDATE task_schedules SET status='SUCCEEDED' WHERE id=?").run(record.id);
    change(task.id, 'COMPLETED'); const before = db.prepare('SELECT * FROM notifications WHERE task_id=?').all(task.id);
    expect(tasks.changeStatus(task.id, 'OPEN', { now: future ? now : new Date(deadline) })?.scheduleEffect).toBe(future ? 'NOTIFICATION_RESTORED' : 'DEADLINE_PASSED');
    expect(schedules.current(task.id)).toMatchObject({ id: record.id, revision: 1 });
    expect(db.prepare('SELECT * FROM notifications WHERE task_id=?').all(task.id)).toEqual(before.map(row => ({ ...Object(row), status: future ? 'SCHEDULED' : 'CANCELLED' })));
  }
  expect(rows('preparation_jobs')).toEqual([]);
});
it('ST-U13 新しい動き: 配信済み通知を繰り返し再開しても再配信しない', async () => {
  const task = create(); const record = schedule(task.id);
  db.prepare("UPDATE task_schedules SET status='SUCCEEDED' WHERE id=?").run(record.id);
  db.prepare("UPDATE notifications SET status='MOCK_DELIVERED' WHERE schedule_id=?").run(record.id);
  for (let i = 0; i < 2; i++) { change(task.id, 'COMPLETED'); expect(change(task.id, 'OPEN')?.scheduleEffect).toBe('NONE'); }
  expect((await schedules.processDue(new Date(deadline), tasks, preparations)).delivered).toBe(0);
  expect(schedules.current(task.id)?.revision).toBe(1);
});
it('ST-U14 新しい動き: 予定がなければ再開の副作用はない', () => {
  const task = create(); change(task.id, 'COMPLETED'); expect(change(task.id, 'OPEN')?.scheduleEffect).toBe('NONE');
  expect(rows('task_schedules')).toEqual([]); expect(rows('notifications')).toEqual([]);
});
it('ST-U15 新しい動き: 予定と通知のINSERT後にタスクUPDATEが失敗しても全表を戻す', () => {
  const task = create(); schedule(task.id); change(task.id, 'COMPLETED');
  const before = [rows('tasks'), rows('task_schedules'), rows('notifications'), rows('preparation_jobs')];
  db.exec(`CREATE TRIGGER reject_reopen BEFORE UPDATE OF status ON tasks
    WHEN NEW.status = 'OPEN'
      AND (SELECT COUNT(*) FROM task_schedules WHERE task_id = NEW.id) = 2
      AND (SELECT COUNT(*) FROM notifications WHERE task_id = NEW.id) = 2
    BEGIN SELECT RAISE(ABORT, 'タスク更新失敗'); END`);
  expect(() => change(task.id, 'OPEN')).toThrow('タスク更新失敗');
  expect([rows('tasks'), rows('task_schedules'), rows('notifications'), rows('preparation_jobs')]).toEqual(before);
});
it('ST-U16 新しい動き: READYと成果物を保ち停止AIだけ初期値に戻す', async () => {
  const ready = create(true); preparations.enqueue(ready); await preparations.runNext(tasks, new MockAiAdapter());
  const artifacts = preparations.listArtifacts(ready.id); change(ready.id, 'COMPLETED');
  expect(tasks.get(ready.id)?.aiStatus).toBe('READY'); change(ready.id, 'OPEN');
  expect(tasks.get(ready.id)?.aiStatus).toBe('READY'); expect(preparations.listArtifacts(ready.id)).toEqual(artifacts);
  for (const required of [false, true]) {
    const task = create(required); tasks.updateAiStatus(task.id, 'CANCELLED'); change(task.id, 'COMPLETED'); change(task.id, 'OPEN');
    expect(tasks.get(task.id)?.aiStatus).toBe(required ? 'WAITING_CONFIRMATION' : 'NOT_REQUIRED');
  }
});
it('ST-U17 新しい動き: 完了後取得した待機ジョブは再開しても戻らず新規依頼は可能', async () => {
  const task = create(true); const job = preparations.enqueue(task, 'old'); change(task.id, 'COMPLETED');
  expect((await preparations.runNext(tasks, new MockAiAdapter()))?.status).toBe('CANCELLED');
  change(task.id, 'OPEN'); expect(preparations.getJob(job.id)?.status).toBe('CANCELLED');
  expect(await preparations.runNext(tasks, new MockAiAdapter())).toBeNull();
  preparations.enqueue(tasks.get(task.id)!, 'new'); expect((await preparations.runNext(tasks, new MockAiAdapter()))?.status).toBe('SUCCEEDED');
});
it('ST-U18 新しい動き: 旧版が残した終了系の期限到来予定と通知を両方停止する', async () => {
  for (const status of ['COMPLETED', 'CANCELLED'] satisfies Task['status'][]) {
    const task = create(); const record = schedule(task.id); rawStatus(task.id, status);
    expect((await schedules.processDue(new Date(deadline), tasks, preparations)).delivered).toBe(0);
    expect(schedules.get(record.id)?.status).toBe('CANCELLED'); expect(schedules.notifications(task.id)[0]?.status).toBe('CANCELLED');
  }
});
it('ST-U19 新しい動き: 削除済みタスクの実行済み予定通知も配信しない', async () => {
  const task = create(); const record = schedule(task.id);
  db.prepare("UPDATE task_schedules SET status='SUCCEEDED' WHERE id=?").run(record.id); tasks.delete(task.id);
  expect((await schedules.processDue(new Date(deadline), tasks, preparations)).delivered).toBe(0);
  expect(schedules.notifications(task.id)[0]?.status).toBe('CANCELLED');
});
it('ST-U20 新しい動き: 終了後の予定保存は拒否し期限だけ更新される競合も防ぐ', () => {
  const task = create(); const input = calculateSchedule({ deadline, now });
  const stale = tasks.get(task.id)!; change(task.id, 'COMPLETED'); const before = rows('tasks');
  expect(stale.status).toBe('OPEN');
  expect(() => schedules.schedule(task.id, input)).toThrow(expect.objectContaining({ code: 'TASK_NOT_ACTIVE' }));
  expect(() => schedules.scheduleForActiveTask(task.id, input, '2030-06-04')).toThrow(expect.objectContaining({ code: 'TASK_NOT_ACTIVE' }));
  expect(rows('tasks')).toEqual(before); expect(rows('task_schedules')).toEqual([]); expect(rows('notifications')).toEqual([]);
});
it('ST-U21 新しい動き: タスク中止とAI停止を区別し副作用5種を日本語で伝える', () => {
  expect(aiStatusLabel('CANCELLED')).toBe('停止'); expect(jobStatusLabel('CANCELLED')).toBe('停止'); expect(statusLabel('CANCELLED')).toBe('中止');
  const suffixes = { NONE: '', STOPPED: '残っていた締切前の通知を止めました（モック）。', RESCHEDULED: '締切前の通知を作り直しました（モック）。', NOTIFICATION_RESTORED: '止めていた締切前の通知を戻しました（モック）。', DEADLINE_PASSED: '締切を過ぎているため、締切前の通知は戻していません。必要なら新しい締切を設定してください。' };
  for (const effect of ['NONE', 'STOPPED', 'RESCHEDULED', 'NOTIFICATION_RESTORED', 'DEADLINE_PASSED'] as const) expect(statusChangeMessage('OPEN', effect, deadline)).toBe(`状態を「未着手」に変更しました。${suffixes[effect]}`);
});
it('ST-U22 新しい動き: 古いexpectedStatusでも変更先が現状態なら無変更成功', () => {
  const task = create(); change(task.id, 'COMPLETED'); const before = rows('tasks');
  expect(tasks.changeStatus(task.id, 'COMPLETED', { now, expectedStatus: 'OPEN' })?.changed).toBe(false); expect(rows('tasks')).toEqual(before);
});
it('ST-U23 回帰の確認: 完了中の準備も保存しREADYになる', async () => {
  const task = create(true); preparations.enqueue(task);
  let release = () => {}; let started = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  const running = preparations.runNext(tasks, { generate: async t => { started(); await gate; return new MockAiAdapter().generate(t); } });
  await entered; tasks.updateStatus(task.id, 'COMPLETED'); release();
  expect((await running)?.status).toBe('SUCCEEDED'); expect(tasks.get(task.id)).toMatchObject({ status: 'COMPLETED', aiStatus: 'READY' }); expect(preparations.listArtifacts(task.id)).toHaveLength(1);
});
it('ST-U23 新しい動き: 進行系切替中の改訂も保存する', async () => {
  const task = create(true); preparations.enqueue(task); await preparations.runNext(tasks, new MockAiAdapter());
  const revised = await preparations.revise(task.id, '例を追加する', tasks, { generate: t => new MockAiAdapter().generate(t), revise: async (t, content, feedback) => {
    change(task.id, 'IN_PROGRESS'); change(task.id, 'OPEN'); return new MockAiAdapter().revise(t, content, feedback);
  } });
  expect(revised.version).toBe(2);
});
it('ST-U24 新しい動き: 取得後enqueue前に完了された古いTaskからジョブを作らない', async () => {
  const task = create(true); const stale = tasks.get(task.id)!; change(task.id, 'COMPLETED');
  expect(() => preparations.enqueue(stale, 'stale')).toThrow(); expect(rows('preparation_jobs')).toEqual([]);
  change(task.id, 'OPEN'); schedule(task.id);
  const enqueue = preparations.enqueue.bind(preparations);
  vi.spyOn(preparations, 'enqueue').mockImplementation((snapshot, key) => { change(task.id, 'COMPLETED'); return enqueue(snapshot, key); });
  await schedules.processDue(new Date('2030-06-03T06:00:00Z'), tasks, preparations);
  expect(rows('preparation_jobs')).toEqual([]);
});

it.each(['closed-read', 'enqueue-rejected'] as const)('ST-U25 新しい動き: %s の終了判定後に再開しても予定と通知を失わない', async (interruption) => {
  const task = create(true);
  const record = schedule(task.id);
  const due = new Date('2030-06-03T06:00:00Z');
  const completeAndReopen = () => {
    expect(schedules.get(record.id)?.status).toBe('RUNNING');
    tasks.changeStatus(task.id, 'COMPLETED', { now: due });
    const closed = tasks.get(task.id)!;
    tasks.changeStatus(task.id, 'OPEN', { now: due });
    return closed;
  };
  if (interruption === 'closed-read') {
    vi.spyOn(tasks, 'get').mockImplementationOnce(completeAndReopen);
  } else {
    const enqueue = preparations.enqueue.bind(preparations);
    vi.spyOn(preparations, 'enqueue').mockImplementationOnce((snapshot, key) => {
      tasks.changeStatus(task.id, 'COMPLETED', { now: due });
      try { return enqueue(snapshot, key); }
      catch (error) {
        tasks.changeStatus(task.id, 'OPEN', { now: due });
        throw error;
      }
    });
  }
  expect(await schedules.processDue(due, tasks, preparations)).toEqual({ started: 0, delivered: 1 });
  expect(tasks.get(task.id)?.status).toBe('OPEN');
  expect(schedules.get(record.id)).toMatchObject({ status: 'SCHEDULED', revision: 1 });
  expect(schedules.notifications(task.id).map(n => n.status)).toEqual(['MOCK_DELIVERED']);
  expect(rows('preparation_jobs')).toEqual([]);
  expect(await schedules.processDue(due, tasks, preparations)).toEqual({ started: 1, delivered: 0 });
  expect(schedules.get(record.id)?.status).toBe('SUCCEEDED');
  expect(rows('preparation_jobs')).toHaveLength(1);
  expect(await schedules.processDue(due, tasks, preparations)).toEqual({ started: 0, delivered: 0 });
});

it.each(['closed-read', 'enqueue-rejected'] as const)('ST-U26 新しい動き: %s の判定後、締切超過で再開しても準備と通知を戻さない', async (interruption) => {
  const task = create(true); const record = schedule(task.id);
  const due = new Date('2030-06-03T06:00:00Z');
  const reopen = () => tasks.changeStatus(task.id, 'OPEN', { now: new Date(deadline) });
  if (interruption === 'closed-read') {
    vi.spyOn(tasks, 'get').mockImplementationOnce(() => {
      tasks.changeStatus(task.id, 'COMPLETED', { now: due });
      const closed = tasks.get(task.id)!;
      expect(reopen()?.scheduleEffect).toBe('DEADLINE_PASSED');
      return closed;
    });
  } else {
    const enqueue = preparations.enqueue.bind(preparations);
    vi.spyOn(preparations, 'enqueue').mockImplementationOnce((snapshot, key) => {
      tasks.changeStatus(task.id, 'COMPLETED', { now: due });
      try { return enqueue(snapshot, key); }
      catch (error) { expect(reopen()?.scheduleEffect).toBe('DEADLINE_PASSED'); throw error; }
    });
  }
  expect(await schedules.processDue(due, tasks, preparations)).toEqual({ started: 0, delivered: 0 });
  expect(schedules.get(record.id)?.status).toBe('FAILED');
  expect(await schedules.processDue(new Date(deadline), tasks, preparations)).toEqual({ started: 0, delivered: 0 });
  expect(rows('preparation_jobs')).toEqual([]);
  expect(schedules.notifications(task.id).map(n => n.status)).toEqual(['CANCELLED']);
});
it('ST-U27 新しい動き: RUNNINGのまま再開して処理を続けても未配信通知が戻る', async () => {
  const task = create(true); const record = schedule(task.id);
  const due = new Date('2030-06-03T06:00:00Z');
  vi.spyOn(tasks, 'get').mockImplementationOnce(() => {
    tasks.changeStatus(task.id, 'COMPLETED', { now: due });
    expect(tasks.changeStatus(task.id, 'OPEN', { now: due })?.scheduleEffect).toBe('NOTIFICATION_RESTORED');
    expect(schedules.get(record.id)?.status).toBe('RUNNING');
    return tasks.get(task.id);
  });
  expect(await schedules.processDue(due, tasks, preparations)).toEqual({ started: 1, delivered: 1 });
  expect(schedules.get(record.id)?.status).toBe('SUCCEEDED');
  expect(rows('preparation_jobs')).toHaveLength(1);
});
it('ST-U28 新しい動き: 締切なしでも古い終了判定後の再開は次周期で一度だけ準備する', async () => {
  const task = create(true); const record = schedule(task.id, null);
  vi.spyOn(tasks, 'get').mockImplementationOnce(() => {
    change(task.id, 'COMPLETED'); const closed = tasks.get(task.id)!;
    change(task.id, 'OPEN'); return closed;
  });
  expect(await schedules.processDue(now, tasks, preparations)).toEqual({ started: 0, delivered: 0 });
  expect(schedules.get(record.id)?.status).toBe('SCHEDULED');
  expect(await schedules.processDue(now, tasks, preparations)).toEqual({ started: 1, delivered: 0 });
  expect(rows('preparation_jobs')).toHaveLength(1);
  expect(schedules.notifications(task.id)).toEqual([]);
});


it.each(['before-task-read', 'before-enqueue'] as const)('ST-U29 R2-01: %s に完了と締切後の再開が割り込んでも新しい準備を作らない', async (interruption) => {
  const task = create(true);
  const record = schedule(task.id);
  const due = new Date('2030-06-03T06:00:00Z');
  const completeAndReopen = () => {
    expect(schedules.get(record.id)?.status).toBe('RUNNING');
    tasks.changeStatus(task.id, 'COMPLETED', { now: due });
    expect(tasks.changeStatus(task.id, 'OPEN', { now: new Date(deadline) })?.scheduleEffect).toBe('DEADLINE_PASSED');
  };
  if (interruption === 'before-task-read') {
    vi.spyOn(tasks, 'get').mockImplementationOnce(() => {
      completeAndReopen();
      return tasks.get(task.id);
    });
  } else {
    const enqueue = preparations.enqueue.bind(preparations);
    vi.spyOn(preparations, 'enqueue').mockImplementationOnce((snapshot, key) => {
      completeAndReopen();
      return enqueue(snapshot, key);
    });
  }
  const result = await schedules.processDue(due, tasks, preparations);
  expect(rows('preparation_jobs')).toEqual([]);
  expect(result).toEqual({ started: 0, delivered: 0 });
  expect(tasks.get(task.id)).toMatchObject({ status: 'OPEN', aiStatus: 'WAITING_CONFIRMATION' });
  expect(schedules.get(record.id)).toMatchObject({ status: 'FAILED', revision: 1 });
  expect(schedules.notifications(task.id).map(n => n.status)).toEqual(['CANCELLED']);
  expect(await schedules.processDue(new Date(deadline), tasks, preparations)).toEqual({ started: 0, delivered: 0 });
});


it('ST-U30 締切なしの停止・再開結果は通知の作成や停止を約束しない', () => {
  for (const effect of ['STOPPED', 'RESCHEDULED'] as const) {
    expect(statusChangeMessage('OPEN', effect, null)).toBe('状態を「未着手」に変更しました。締切がないため、通知は設定していません（モック）。');
  }
});


it.each(['SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const)('ST-U31 予定が%sなら古いTaskから予定由来のジョブを作らない', status => {
  const task = create(true);
  const record = schedule(task.id);
  db.prepare('UPDATE task_schedules SET status = ? WHERE id = ?').run(status, record.id);
  const before = rows('tasks');
  expect(() => preparations.enqueue(task, `schedule:${record.id}`)).toThrow('このタスクは準備を開始できません。');
  expect(rows('preparation_jobs')).toEqual([]);
  expect(rows('tasks')).toEqual(before);
});
it('ST-U32 他タスクのRUNNING予定と存在しない予定ではジョブを作らない', () => {
  const task = create(true);
  const other = create(true);
  const record = schedule(other.id);
  db.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ?").run(record.id);
  expect(() => preparations.enqueue(task, `schedule:${record.id}`)).toThrow();
  expect(() => preparations.enqueue(task, `schedule:${task.id}`)).toThrow();
  expect(rows('preparation_jobs')).toEqual([]);
});
it.each(['OPEN', 'IN_PROGRESS'] as const)('ST-U33 締切後でも%sの手動準備と同タスクRUNNING予定からの準備は可能', status => {
  const task = create(true);
  const record = schedule(task.id, '2000-01-01T00:00:00.000Z');
  db.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ?").run(record.id);
  tasks.postpone(task.id, '2000-01-01');
  change(task.id, status);
  expect(preparations.enqueue(task, 'manual-overdue').status).toBe('QUEUED');
  expect(preparations.enqueue(task, `schedule:${record.id}`).status).toBe('QUEUED');
  expect(rows('preparation_jobs')).toHaveLength(2);
});
it('ST-U34 締切後再開でもenqueue済みのジョブとRUNNINGの履歴は保つ', async () => {
  const task = create(true);
  const record = schedule(task.id);
  db.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ?").run(record.id);
  const job = preparations.enqueue(task, `schedule:${record.id}`);
  change(task.id, 'COMPLETED');
  tasks.changeStatus(task.id, 'OPEN', { now: new Date(deadline) });
  expect(schedules.get(record.id)?.status).toBe('RUNNING');
  expect(preparations.getJob(job.id)?.status).toBe('QUEUED');
  expect((await preparations.runNext(tasks, new MockAiAdapter()))?.status).toBe('SUCCEEDED');
  expect(preparations.listArtifacts(task.id)).toHaveLength(1);
});
it('ST-U35 最新以外も締切後再開でenqueue前のRUNNINGを終了する', () => {
  const task = create(true);
  const old = schedule(task.id);
  db.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ?").run(old.id);
  const latest = schedule(task.id);
  db.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ?").run(latest.id);
  change(task.id, 'COMPLETED');
  tasks.changeStatus(task.id, 'OPEN', { now: new Date(deadline) });
  expect(schedules.get(old.id)?.status).toBe('FAILED');
  expect(schedules.get(latest.id)?.status).toBe('FAILED');
  expect(() => preparations.enqueue(tasks.get(task.id)!, `schedule:${old.id}`)).toThrow();
  expect(rows('preparation_jobs')).toEqual([]);
});
it('ST-U36 ジョブ表未作成でも締切後再開でRUNNINGを終了する', () => {
  const isolated = new TaskStore(join(directory, 'tasks-only.sqlite'));
  const isolatedSchedules = new ScheduleStore(join(directory, 'tasks-only.sqlite'));
  const isolatedDb = new Database(join(directory, 'tasks-only.sqlite'));
  try {
    const task = isolated.create({ title: 'ジョブ表なしの再開' });
    const record = isolatedSchedules.schedule(task.id, calculateSchedule({ deadline, now }));
    isolatedDb.prepare("UPDATE task_schedules SET status = 'RUNNING' WHERE id = ?").run(record.id);
    isolated.changeStatus(task.id, 'COMPLETED', { now });
    expect(isolated.changeStatus(task.id, 'OPEN', { now: new Date(deadline) })?.scheduleEffect).toBe('DEADLINE_PASSED');
    expect(isolatedSchedules.get(record.id)?.status).toBe('FAILED');
  } finally { isolatedDb.close(); isolatedSchedules.close(); isolated.close(); }
});
