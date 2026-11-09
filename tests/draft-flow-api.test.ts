import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { DraftFlowStore } from '../src/adapters/draft-flow-store';
import { draftHandlers } from '../src/adapters/draft-api';
import { MockAiAdapter } from '../src/adapters/mock-ai';
import { ReferenceStore } from '../src/adapters/reference-store';
import { CliAiAdapter } from '../src/adapters/cli-ai';
import { withReferences } from '../src/adapters/with-references';
import { GET as artifacts } from '../src/app/api/tasks/[id]/artifacts/route';
import { POST as feedback } from '../src/app/api/tasks/[id]/feedback/route';
import type { PreparationAdapter } from '../src/adapters/mock-ai';
import { createSessionToken } from '../src/domain/session';

const active = vi.hoisted(() => ({ stores: null as null | { taskStore: TaskStore; preparationStore: PreparationStore; breakdownStore: BreakdownStore; draftFlowStore: DraftFlowStore; preparationAdapter: PreparationAdapter } }));
vi.mock('../src/adapters/runtime', () => ({
  get taskStore() { return active.stores!.taskStore; },
  get preparationStore() { return active.stores!.preparationStore; },
  get breakdownStore() { return active.stores!.breakdownStore; },
  get draftFlowStore() { return active.stores!.draftFlowStore; },
  get preparationAdapter() { return active.stores!.preparationAdapter; },
  reviewStore: { rating: () => 'UNRATED', approval: () => 'UNAPPROVED' },
}));

let dir: string; let tasks: TaskStore; let preparations: PreparationStore; let breakdown: BreakdownStore;
let drafts: DraftFlowStore; let db: Database.Database; let cookie: string; let handle: ReturnType<typeof draftHandlers>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draft-api-'));
  const path = join(dir, 'db.sqlite');
  tasks = new TaskStore(path); preparations = new PreparationStore(path, join(dir, 'artifacts'));
  breakdown = new BreakdownStore(path); drafts = new DraftFlowStore(path, join(dir, 'artifacts')); db = new Database(path);
  const secret = randomBytes(32).toString('hex');
  vi.stubEnv('SESSION_SECRET', secret); vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com'); vi.stubEnv('AUTH_MODE', 'test');
  cookie = `task-planner-session=${createSessionToken(secret, 'owner@example.com')}`;
  handle = draftHandlers({ tasks, drafts });
  active.stores = { taskStore: tasks, preparationStore: preparations, breakdownStore: breakdown, draftFlowStore: drafts, preparationAdapter: new MockAiAdapter() };
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); drafts.close(); breakdown.close(); preparations.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }); });
function request(id: string, body?: unknown, headers: Record<string, string> = {}) {
  return handle(new Request(`http://localhost/api/tasks/${id}/draft`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), id);
}
function fixture(steps = ['資料を確認する', '結論を書く']) {
  const task = tasks.create({ title: '架空の教材' });
  breakdown.mutate(task.id, { action: 'save', baseVersion: null, steps, requestKey: randomUUID() });
  const version = breakdown.snapshot(task.id).versions.at(-1)!;
  return { task, version, command: { action: 'create', breakdownVersionId: version.id, requestKey: randomUUID() } };
}
function rows() {
  const tables = z.array(z.object({ name: z.string() })).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all());
  return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}
it('DF-A01/A02 GETは状態と作成可否を返し全表を書き換えない', async () => {
  const { task, version } = fixture(); const before = rows();
  const response = await request(task.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ preparationActive: false, breakdown: { latestVersionId: version.id, stepCount: 2, busy: false }, draft: null, stale: false, job: null, canCreate: true, blockReason: null });
  expect(rows()).toEqual(before);
  const empty = tasks.create({ title: '分解なし' });
  expect(await (await request(empty.id)).json()).toMatchObject({ canCreate: false, blockReason: 'NO_BREAKDOWN' });
  breakdown.mutate(task.id, { action: 'save', baseVersion: version.id, steps: [], requestKey: randomUUID() });
  expect(await (await request(task.id)).json()).toMatchObject({ canCreate: false, blockReason: 'EMPTY_BREAKDOWN' });
  tasks.updateStatus(task.id, 'COMPLETED');
  expect(await (await request(task.id)).json()).toMatchObject({ canCreate: false, blockReason: 'TASK_NOT_RUNNABLE' });
});
it('DF-A03 作成202と取消200は同じsnapshot形式で再送に対応する', async () => {
  const { task, command } = fixture();
  const created = await request(task.id, command); expect(created.status).toBe(202);
  const data = await created.json(); expect(data.job.status).toBe('QUEUED'); expect(data.canCreate).toBe(false);
  expect(await (await request(task.id, command)).json()).toEqual(data);
  const cancelled = await request(task.id, { action: 'cancel', jobId: data.job.id });
  expect(cancelled.status).toBe(200); expect((await cancelled.json()).job.status).toBe('CANCELLED');
  expect((await request(task.id, { action: 'cancel', jobId: data.job.id })).status).toBe(200);
});
it('DF-A04 認証・送信元・形式・存在とタスクをまたぐ取消を拒否する', async () => {
  const { task, command } = fixture();
  expect((await request(task.id, undefined, { cookie: '' })).status).toBe(401);
  expect((await request(task.id, command, { origin: 'https://other.example.com' })).status).toBe(403);
  expect((await request(randomUUID())).status).toBe(404);
  expect((await request(task.id, { action: 'create' })).status).toBe(422);
  const response = await request(task.id, { action: 'cancel', jobId: randomUUID() });
  expect(response.status).toBe(404); expect(await response.json()).toEqual({ code: 'NOT_FOUND', error: '対象が見つかりません。' });
  const made = await (await request(task.id, command)).json();
  const other = fixture();
  expect((await request(other.task.id, { action: 'cancel', jobId: made.job.id })).status).toBe(404);
});
it('DF-A04 空・不正・版違い・実行中・キー再利用の日本語応答が仕様と一致する', async () => {
  const { task, version, command } = fixture();
  async function error(body: unknown, status: number, code: string, message: string) {
    const response = await request(task.id, body); expect(response.status).toBe(status); expect(await response.json()).toEqual({ code, error: message });
  }
  await error({ ...command, breakdownVersionId: randomUUID() }, 409, 'BREAKDOWN_CHANGED', '分解が更新されました。最新の分解を確認してからもう一度押してください。');
  await request(task.id, command);
  await error({ ...command, requestKey: 'other' }, 409, 'DRAFT_JOB_ACTIVE', 'ドラフトを作成中です。完了までお待ちください。');
  await error({ ...command, breakdownVersionId: randomUUID() }, 409, 'CONFLICT', 'この操作は別の内容で受け付け済みです。画面を読み込み直してください。');
  drafts.cancel(task.id, drafts.snapshot(task.id).job!.id);
  breakdown.mutate(task.id, { action: 'save', baseVersion: version.id, steps: [], requestKey: 'empty' });
  await error({ ...command, requestKey: 'empty' , breakdownVersionId: breakdown.snapshot(task.id).versions.at(-1)!.id }, 422, 'BREAKDOWN_EMPTY', '分解の項目を1件以上保存してからドラフトを作ってください。');
});
it('DF-A01 作成済みドラフトの基準版・mode・変更案内を返す', async () => {
  const { task, version, command } = fixture();
  await request(task.id, command); await drafts.runNextDraft(tasks, new MockAiAdapter());
  const before = rows(); const response = await request(task.id); const data = await response.json();
  expect(data).toMatchObject({ draft: { version: 1, mode: 'mock', modeLabel: 'モック', basedOnVersionId: version.id, basedOnNumber: 1, tracking: 'TRACKED' }, stale: false });
  expect(rows()).toEqual(before);
  breakdown.mutate(task.id, { action: 'save', baseVersion: version.id, steps: ['変更した手順'], requestKey: 'changed' });
  expect(await (await request(task.id)).json()).toMatchObject({ stale: true, canCreate: true });
});

function revise(id: string, content: unknown = '結論を簡潔に') {
  return feedback(new Request(`http://localhost/api/tasks/${id}/feedback`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content }) }), { params: Promise.resolve({ id }) });
}
it('DF-A05 feedbackは今の分解と資料を使いリンクを記録し分解を変えない', async () => {
  const { task, version, command } = fixture();
  await request(task.id, command); await drafts.runNextDraft(tasks, new MockAiAdapter());
  breakdown.mutate(task.id, { action: 'save', baseVersion: version.id, steps: ['編集済みの手順を読む'], requestKey: 'edited' });
  const before = breakdown.snapshot(task.id).versions;
  const references = new ReferenceStore(join(dir, 'db.sqlite'));
  try {
    references.add(task.id, { kind: 'NOTE', body: '改訂で参照する本文' });
    const prompts: string[] = [];
    active.stores!.preparationAdapter = withReferences(new CliAiAdapter(async prompt => { prompts.push(prompt); return JSON.stringify({ draftMarkdown: '# 修正した下書き' }); }), references);
    const response = await revise(task.id); expect(response.status).toBe(201);
    const data = await response.json(); expect(data.artifact.version).toBe(2); expect(data.label).toBe('AI生成');
    expect(prompts[0]).toContain('編集済みの手順を読む'); expect(prompts[0]).toContain('改訂で参照する本文');
    expect(breakdown.snapshot(task.id).versions).toEqual(before);
    expect(db.prepare('SELECT breakdown_version_id FROM draft_version_links WHERE artifact_version_id=?').get(data.artifact.versionId)).toEqual({ breakdown_version_id: version.id });
    expect(drafts.snapshot(task.id).stale).toBe(true);
  } finally { references.close(); }
});
it('DF-A06/A90 作成中のfeedbackは409で拒否し既存404・422を保つ', async () => {
  const { task, command } = fixture(); await request(task.id, command);
  const response = await revise(task.id); expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'DRAFT_JOB_ACTIVE', error: 'ドラフトを作成中です。完了までお待ちください。' });
  expect((await revise(randomUUID())).status).toBe(404);
  expect((await revise(task.id, '')).status).toBe(422);
});

it('DF-A04 分解未登録・不正・準備中・再生成中・完了・中止のHTTPとcodeと文言', async () => {
  const { task, version, command } = fixture();
  const check = async (id: string, body: unknown, status: number, code: string, message: string) => {
    const response = await request(id, body); expect(response.status).toBe(status); expect(await response.json()).toEqual({ code, error: message });
  };
  const none = tasks.create({ title: '未登録' });
  await check(none.id, { ...command, breakdownVersionId: randomUUID() }, 422, 'BREAKDOWN_EMPTY', '分解の項目を1件以上保存してからドラフトを作ってください。');
  db.prepare('UPDATE breakdown_versions SET data_json=? WHERE id=?').run(JSON.stringify({ ...version, steps: ['長'.repeat(301)] }), version.id);
  await check(task.id, command, 422, 'BREAKDOWN_INVALID', '分解の項目は1〜300字、最大50件にして保存し直してください。');
  db.prepare('UPDATE breakdown_versions SET data_json=? WHERE id=?').run(JSON.stringify(version), version.id);
  preparations.enqueue(task, 'prepare');
  await check(task.id, command, 409, 'BREAKDOWN_BUSY', 'AIが分解を作成中です。完了してからドラフトを作ってください。');
  db.prepare("UPDATE preparation_jobs SET status='CANCELLED' WHERE task_id=?").run(task.id);
  breakdown.mutate(task.id, { action: 'regenerate', baseVersion: version.id, steps: version.steps, comment: '確認する', requestKey: 'regenerate' });
  await check(task.id, command, 409, 'BREAKDOWN_BUSY', 'AIが分解を作成中です。完了してからドラフトを作ってください。');
  for (const status of ['COMPLETED', 'CANCELLED'] as const) {
    tasks.updateStatus(task.id, status);
    await check(task.id, command, 409, 'TASK_NOT_RUNNABLE', '完了・中止したタスクではドラフトを作れません。');
  }
});

it('成果物APIは版ごとの作成経路を返し記録のない旧版はnullにする', async () => {
  const { task, command } = fixture();
  await request(task.id, command); await drafts.runNextDraft(tasks, new MockAiAdapter());
  expect((await revise(task.id)).status).toBe(201);
  await request(task.id, { ...command, requestKey: randomUUID() });
  await drafts.runNextDraft(tasks, new MockAiAdapter());
  const readArtifacts = async () => (await (await artifacts(new Request('http://localhost'), { params: Promise.resolve({ id: task.id }) })).json()).artifacts;
  expect(await readArtifacts()).toMatchObject([{ version: 1, source: 'CREATE' }, { version: 2, source: 'REVISE' }, { version: 3, source: 'CREATE' }]);
  db.prepare('DELETE FROM draft_version_links WHERE task_id=?').run(task.id);
  const before = rows();
  expect(await readArtifacts()).toMatchObject([{ source: null }, { source: null }, { source: null }]);
  expect(rows()).toEqual(before);
});
