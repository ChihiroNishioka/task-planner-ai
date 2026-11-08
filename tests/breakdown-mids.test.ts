import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { breakdownHandlers } from '../src/adapters/breakdown-api';
import { breakdownSnapshotSchema } from '../src/domain/breakdown';
import { createSessionToken } from '../src/domain/session';
import { CliAiAdapter } from '../src/adapters/cli-ai';

let dir: string;
let tasks: TaskStore;
let preparations: PreparationStore;
let store: BreakdownStore;
let cancellingStore: BreakdownStore;
let handle: ReturnType<typeof breakdownHandlers>;
let cookie: string;

beforeEach(() => {
  const root = process.env.UNIT_DATA_DIR ?? tmpdir();
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, 'breakdown-mids-'));
  const path = join(dir, 'db.sqlite');
  tasks = new TaskStore(path);
  preparations = new PreparationStore(path, join(dir, 'artifacts'));
  store = new BreakdownStore(path);
  cancellingStore = new BreakdownStore(path);
  handle = breakdownHandlers({ tasks, preparations, breakdown: cancellingStore });
  const secret = randomBytes(32).toString('hex');
  vi.stubEnv('AUTH_MODE', 'test');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SESSION_SECRET', secret);
  vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
  cookie = `task-planner-session=${createSessionToken(secret, 'owner@example.com')}`;
});
afterEach(() => {
  vi.unstubAllEnvs();
  cancellingStore.close(); store.close(); preparations.close(); tasks.close();
  rmSync(dir, { recursive: true, force: true });
});
function post(taskId: string, body: unknown, headers: Record<string, string> = {}) {
  return handle(new Request(`http://localhost/api/tasks/${taskId}/breakdown`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), taskId);
}
async function read(taskId: string) {
  const response = await handle(new Request(`http://localhost/api/tasks/${taskId}/breakdown`, { headers: { cookie } }), taskId);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return breakdownSnapshotSchema.parse(await response.json());
}
function setup() {
  const task = tasks.create({ title: '架空の分解回帰確認', category: 'STUDY' });
  const initial = store.mutate(task.id, { action: 'save', baseVersion: null, requestKey: randomUUID(), steps: ['旧版の教材を読む'] });
  const baseVersion = initial.versions[0]!.id;
  const queued = store.mutate(task.id, { action: 'regenerate', baseVersion, requestKey: randomUUID(), steps: ['未保存の教材を読む'], comment: '架空の練習を増やす' });
  return { task, baseVersion, initial, job: queued.jobs[0]! };
}
const cancel = (jobId: string, requestKey = randomUUID()) => ({ action: 'cancel', jobId, requestKey });
const fakeCli = () => new CliAiAdapter(async () => JSON.stringify({ steps: ['偽CLIの新版を確認する'] }));

it('MID3-Q 待機取消は二重送信に安全で再起動後も履歴と入力を保持し再生成できる', async () => {
  const { task, job, initial, baseVersion } = setup();
  const command = cancel(job.id);
  expect((await post(task.id, command)).status).toBe(200);
  expect((await post(task.id, command)).status).toBe(200);
  expect((await post(task.id, cancel(job.id))).status).toBe(200);
  expect(await store.runNext(tasks, preparations, fakeCli())).toBeNull();
  store.close(); store = new BreakdownStore(join(dir, 'db.sqlite'));
  const cancelled = await read(task.id);
  expect(cancelled.versions).toEqual(initial.versions);
  expect(cancelled.jobs).toHaveLength(1);
  expect(cancelled.jobs[0]).toMatchObject({ ...job, status: 'CANCELLED', errorCode: null });
  expect((await post(task.id, { action: 'regenerate', baseVersion, requestKey: randomUUID(), steps: job.inputSteps, comment: job.comment })).status).toBe(202);
  await store.runNext(tasks, preparations, fakeCli());
  expect((await read(task.id)).jobs.map(item => item.status).sort()).toEqual(['CANCELLED', 'SUCCEEDED']);
  expect((await read(task.id)).versions).toHaveLength(2);
});

it.each(['success', 'failure'] as const)('MID3-R 実行中の別接続からの取消後に遅い%sが返っても新版を保存しない', async (outcome) => {
  const { task, job, initial } = setup();
  let release: (value: string) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  let signalStarted: () => void = () => {};
  const gate = new Promise<string>((resolve, fail) => { release = resolve; reject = fail; });
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const running = store.runNext(tasks, preparations, new CliAiAdapter(() => { signalStarted(); return gate; }));
  try {
    await started;
    expect((await read(task.id)).jobs[0]?.status).toBe('RUNNING');
    expect((await post(task.id, cancel(job.id))).status).toBe(200);
  } finally {
    if (outcome === 'success') release(JSON.stringify({ steps: ['保存してはいけない遅い偽CLI結果'] }));
    else reject(new Error('架空の遅い生成失敗'));
    await running;
  }
  const result = await read(task.id);
  expect(result.jobs[0]).toMatchObject({ status: 'CANCELLED', errorCode: null });
  expect(result.versions).toEqual(initial.versions);
});

it('MID3-BOUNDARY 他タスクと存在しないjobは404で変更せずキーの使い回しは409', async () => {
  const a = setup(); const b = setup();
  const beforeA = await read(a.task.id); const beforeB = await read(b.task.id);
  expect((await post(a.task.id, cancel(b.job.id))).status).toBe(404);
  expect((await post(a.task.id, cancel(randomUUID()))).status).toBe(404);
  expect(await read(a.task.id)).toEqual(beforeA);
  expect(await read(b.task.id)).toEqual(beforeB);
  const command = cancel(a.job.id);
  expect((await post(a.task.id, command)).status).toBe(200);
  expect((await post(a.task.id, { ...command, jobId: b.job.id })).status).toBe(409);
  expect(await read(b.task.id)).toEqual(beforeB);
});
it('MID3-BOUNDARY 取消は版が進んでもbaseVersionなしで対象ジョブだけを取り消す', async () => {
  const { task, job, baseVersion } = setup();
  store.mutate(task.id, { action: 'save', baseVersion, requestKey: randomUUID(), steps: ['別タブが保存した新版'] });
  const before = await read(task.id);
  expect((await post(task.id, cancel(job.id))).status).toBe(200);
  expect((await read(task.id)).versions).toEqual(before.versions);
});
it.each(['SUCCEEDED', 'FAILED'] as const)('MID3-BOUNDARY %s確定が先なら取消409で状態と旧版を変えない', async (status) => {
  const { task, job } = setup();
  await store.runNext(tasks, preparations, status === 'SUCCEEDED' ? fakeCli() : new CliAiAdapter(async () => { throw new Error('架空の生成失敗'); }));
  const before = await read(task.id);
  expect(before.jobs[0]?.status).toBe(status);
  expect((await post(task.id, cancel(job.id))).status).toBe(409);
  expect(await read(task.id)).toEqual(before);
});
it('MID3-BOUNDARY 未認証・別Origin・不正JSON・不正jobIdは拒否し副作用を残さない', async () => {
  const { task, job } = setup(); const before = await read(task.id);
  expect((await post(task.id, cancel(job.id), { cookie: '' })).status).toBe(401);
  expect((await post(task.id, cancel(job.id), { origin: 'https://other.example.com' })).status).toBe(403);
  expect((await post(task.id, cancel('invalid'))).status).toBe(422);
  expect((await post(task.id, { action: 'cancel', jobId: job.id, requestKey: '' })).status).toBe(422);
  expect((await post(task.id, { ...cancel(job.id), unexpected: true })).status).toBe(422);
  expect((await handle(new Request('http://localhost/', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{' }), task.id)).status).toBe(422);
  expect(await read(task.id)).toEqual(before);
});
it.each(['COMPLETED', 'CANCELLED', 'DELETED'] as const)('MID3-BOUNDARY %sタスクの取消は拒否する', async (status) => {
  const { task, job } = setup();
  if (status === 'DELETED') tasks.delete(task.id); else tasks.updateStatus(task.id, status);
  const before = store.snapshot(task.id);
  expect((await post(task.id, cancel(job.id))).status).toBe(status === 'DELETED' ? 404 : 409);
  expect(store.snapshot(task.id)).toEqual(before);
});
it('MID1-RACE 明示的な基準版更新による保存と再競合は旧履歴を上書きしない', async () => {
  const { task, baseVersion, initial } = setup();
  await store.runNext(tasks, preparations, fakeCli());
  const stale = { action: 'save', baseVersion, requestKey: randomUUID(), steps: ['入力を保持して載せ替える'] };
  expect((await post(task.id, stale)).status).toBe(409);
  const comparison = await read(task.id);
  const comparedVersion = comparison.versions.at(-1)!.id;
  store.mutate(task.id, { action: 'save', baseVersion: comparedVersion, requestKey: randomUUID(), steps: ['比較表示後の別タブ編集'] });
  expect((await post(task.id, { ...stale, baseVersion: comparedVersion, requestKey: randomUUID() })).status).toBe(409);
  const latest = await read(task.id);
  expect((await post(task.id, { ...stale, baseVersion: latest.versions.at(-1)!.id, requestKey: randomUUID() })).status).toBe(200);
  const saved = await read(task.id);
  expect(saved.versions).toHaveLength(4);
  expect(saved.versions[0]).toEqual(initial.versions[0]);
  expect(saved.versions.at(-1)).toMatchObject({ steps: stale.steps, parentVersion: latest.versions.at(-1)!.id });
});
