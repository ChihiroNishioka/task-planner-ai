import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { breakdownHandlers } from '../src/adapters/breakdown-api';
import { createSessionToken } from '../src/domain/session';
import { breakdownSnapshotSchema } from '../src/domain/breakdown';
import { MockAiAdapter } from '../src/adapters/mock-ai';
import { buildWorkerEnv } from './helpers/safe-ai-env';

let dir: string; let tasks: TaskStore; let preparations: PreparationStore; let breakdown: BreakdownStore;
let handle: ReturnType<typeof breakdownHandlers>; let cookie: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'breakdown-api-'));
  const path = join(dir, 'db.sqlite'); tasks = new TaskStore(path); preparations = new PreparationStore(path, join(dir, 'artifacts')); breakdown = new BreakdownStore(path);
  handle = breakdownHandlers({ tasks, preparations, breakdown });
  const secret = randomBytes(32).toString('hex');
  vi.stubEnv('SESSION_SECRET', secret); vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com'); vi.stubEnv('AUTH_MODE', 'test');
  cookie = `task-planner-session=${createSessionToken(secret, 'owner@example.com')}`;
});
afterEach(() => { vi.unstubAllEnvs(); breakdown.close(); preparations.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }); });
function request(id: string, body?: unknown, authenticated = true) {
  return handle(new Request(`http://localhost/api/tasks/${id}/breakdown`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), id);
}
it('BE-09 proxyを迂回したAPI呼び出しも認証を必要とする', async () => {
  const t = tasks.create({ title: '架空の教材' });
  expect((await request(t.id, undefined, false)).status).toBe(401);
  expect((await request(t.id, { action: 'save', baseVersion: null, requestKey: 'anon', steps: [] }, false)).status).toBe(401);
  vi.stubEnv('NODE_ENV', 'production'); expect((await request(t.id)).status).toBe(401);
});
it('BE-04/06 APIは保存・再送・409・422・404を返す', async () => {
  const t = tasks.create({ title: '架空の教材' });
  const command = { action: 'save', baseVersion: null, requestKey: 'save', steps: ['教材を読む'] };
  const first = await request(t.id, command); expect(first.status).toBe(200);
  expect(await (await request(t.id, command)).json()).toEqual(await first.json());
  expect((await request(t.id, { ...command, requestKey: 'other' })).status).toBe(409);
  expect((await request(t.id, { ...command, steps: [''] })).status).toBe(422);
  expect((await request('not-uuid')).status).toBe(404);
  expect((await handle(new Request('http://localhost/', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{' }), t.id)).status).toBe(422);
  expect((await handle(new Request('http://localhost/', { method: 'POST', headers: { cookie, origin: 'http://other.example', 'content-type': 'application/json' }, body: '{}' }), t.id)).status).toBe(403);
});
it('BE-02 既存worker --onceは既存runNextが空でも分解ジョブを処理する', async () => {
  const t = tasks.create({ title: '架空の教材' });
  expect((await request(t.id, { action: 'regenerate', baseVersion: null, requestKey: 'worker', steps: ['保存前の教材を読む'], comment: '例題を追加する' })).status).toBe(202);
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts', '--once'], { timeout: 20_000, env: { NODE_ENV: 'test', ...buildWorkerEnv(process.env, { DATABASE_PATH: join(dir, 'db.sqlite'), ARTIFACT_DIRECTORY: join(dir, 'artifacts'), BLOB_DIRECTORY: join(dir, 'blobs') }, process.cwd()) }, stdio: 'pipe' });
  const snapshot = breakdownSnapshotSchema.parse(await (await request(t.id)).json());
  expect(snapshot.versions[0]?.kind).toBe('ai'); expect(snapshot.jobs[0]?.status).toBe('SUCCEEDED');
});


it.each(['COMPLETED', 'CANCELLED'] as const)('BE-08 GETは%sの旧長文・多項目を返しPOSTだけ拒否する', async (status) => {
  const t = tasks.create({ title: '架空の旧タスク' });
  const steps = ['旧'.repeat(301), ...Array(51).fill('旧手順')];
  preparations.enqueue(t, 'legacy-api');
  await preparations.runNext(tasks, { generate: async (task) => {
    const result = await new MockAiAdapter().generate(task);
    return { ...result, plan: { ...result.plan, steps } };
  } });
  tasks.updateStatus(t.id, status);
  const response = await request(t.id); expect(response.status).toBe(200);
  const data = breakdownSnapshotSchema.parse(await response.json());
  expect(data.versions[0]?.steps).toEqual(steps);
  expect((await request(t.id, { action: 'save', baseVersion: data.versions[0]!.id, requestKey: 'denied', steps: [] })).status).toBe(409);
  const reread = breakdownSnapshotSchema.parse(await (await request(t.id)).json());
  expect(reread.versions).toEqual(data.versions);
});
