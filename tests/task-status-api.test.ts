import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TaskStore } from '../src/adapters/task-store';
import { ScheduleStore } from '../src/adapters/scheduling';
import { taskHandlers } from '../src/adapters/task-api';

let directory: string;
let tasks: TaskStore;
let schedules: ScheduleStore;
let api: ReturnType<typeof taskHandlers>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'status-api-'));
  const path = join(directory, 'db.sqlite');
  tasks = new TaskStore(path); schedules = new ScheduleStore(path);
  api = taskHandlers({ tasks, schedules });
});
afterEach(() => { schedules.close(); tasks.close(); rmSync(directory, { recursive: true, force: true }); });
const request = (body: unknown) => new Request('http://localhost/api/tasks/test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
it('ST-A01 新しい動き 完了から再開の応答', async () => {
  const task = tasks.create({ title: '再開' }); tasks.updateStatus(task.id, 'COMPLETED');
  const response = await api.PATCH(request({ status: 'OPEN', expectedStatus: 'COMPLETED' }), task.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ task: { status: 'OPEN', completedAt: null }, changed: true, scheduleEffect: 'NONE', label: 'モック' });
});
it('ST-A02 新しい動き 完了日時はGETと一覧でも同じ', async () => {
  const task = tasks.create({ title: '完了' });
  const response = await api.PATCH(request({ status: 'COMPLETED' }), task.id);
  const body = await response.json();
  expect(body.task.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await (await api.GET(new Request('http://localhost'), task.id)).json()).toMatchObject({ task: { completedAt: body.task.completedAt } });
  expect(tasks.list()[0].completedAt).toBe(body.task.completedAt);
});
it('ST-A03 新しい動き 同状態の無変更', async () => {
  const task = tasks.create({ title: '同状態' });
  const response = await api.PATCH(request({ status: 'OPEN' }), task.id);
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ changed: false });
});
it('ST-A04 新しい動き 競合に最新タスクと現在の状態名', async () => {
  const task = tasks.create({ title: '競合' }); tasks.updateStatus(task.id, 'COMPLETED');
  const response = await api.PATCH(request({ status: 'IN_PROGRESS', expectedStatus: 'OPEN' }), task.id);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'STATUS_CONFLICT', error: '別の画面で状態が「完了」に変わりました。内容を確認して、もう一度操作してください。', task: { status: 'COMPLETED' } });
});
it('ST-A05 回帰の確認（404）と新しい動き（code） 不存在と削除済み', async () => {
  const task = tasks.create({ title: '削除' }); tasks.delete(task.id);
  for (const id of [task.id, 'missing']) {
    const response = await api.PATCH(request({ status: 'OPEN' }), id);
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  }
});
it.each([
  { status: 'INVALID' }, { status: 'OPEN', expectedStatus: 'INVALID' }, { expectedStatus: 'OPEN' },
  { status: 'COMPLETED', title: '変更' }, { status: 'COMPLETED', deadline: '2026-11-13' },
])('ST-A06 新しい動き 不正入力は422でDB不変 %j', async (body) => {
  const task = tasks.create({ title: '入力' });
  const response = await api.PATCH(request(body), task.id);
  expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' });
  expect(tasks.get(task.id)).toEqual(task);
});
it('ST-A07 回帰の確認（title応答）と新しい動き（完了日時）', async () => {
  const task = tasks.create({ title: '変更前' });
  const response = await api.PATCH(request({ title: '変更後' }), task.id);
  const body = await response.json();
  expect(response.status).toBe(200); expect(body).not.toHaveProperty('changed');
  expect(body.task).toMatchObject({ title: '変更後', completedAt: null });
});
it.each(['COMPLETED', 'CANCELLED'] as const)('ST-A08 新しい動き 終了系%sの期限・予定・通知は不変', async (status) => {
  const task = tasks.create({ title: '予定', deadline: '2026-11-12' }); tasks.updateStatus(task.id, status);
  const before = tasks.get(task.id);
  const response = await api.schedulePOST(request({ deadline: '2026-11-13T17:00:00+09:00' }), task.id);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'TASK_NOT_ACTIVE', error: '完了・中止したタスクには期限と通知を設定できません。再開してから設定してください。' });
  expect(tasks.get(task.id)).toEqual(before); expect(schedules.current(task.id)).toBeNull(); expect(schedules.notifications(task.id)).toEqual([]);
});
