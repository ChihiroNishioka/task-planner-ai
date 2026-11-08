import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createSessionToken } from '../src/domain/session';
import { breakdownHandlers } from '../src/adapters/breakdown-api';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { TaskStore } from '../src/adapters/task-store';
import { ReferenceStore } from '../src/adapters/reference-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { ReviewStore } from '../src/adapters/review-store';
import { CliAiAdapter, FallbackAiAdapter } from '../src/adapters/cli-ai';
import { MockAiAdapter, type PreparationAdapter } from '../src/adapters/mock-ai';
import { withReferences } from '../src/adapters/with-references';
import { POST } from '../src/app/api/tasks/[id]/feedback/route';

const runtime = vi.hoisted(() => new Map<string, {
  taskStore: TaskStore; preparationStore: PreparationStore; reviewStore: ReviewStore; preparationAdapter: PreparationAdapter;
}>());
vi.mock('../src/adapters/runtime', () => ({
  get taskStore() { return runtime.get('active')!.taskStore; },
  get preparationStore() { return runtime.get('active')!.preparationStore; },
  get reviewStore() { return runtime.get('active')!.reviewStore; },
  get preparationAdapter() { return runtime.get('active')!.preparationAdapter; },
}));

let directory: string;
let tasks: TaskStore;
let references: ReferenceStore;
let preparations: PreparationStore;
let reviews: ReviewStore;
let prompts: string[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reference-integration-'));
  const path = join(directory, 'db.sqlite');
  tasks = new TaskStore(path);
  references = new ReferenceStore(path);
  preparations = new PreparationStore(path, join(directory, 'artifacts'));
  reviews = new ReviewStore(path);
  prompts = [];
  const adapter = new CliAiAdapter(async prompt => {
    prompts.push(prompt);
    return JSON.stringify({ steps: ['確認', '作成'], draftMarkdown: '# 統合テスト用の下書き' });
  });
  runtime.set('active', { taskStore: tasks, preparationStore: preparations, reviewStore: reviews, preparationAdapter: withReferences(adapter, references) });
});
afterEach(() => {
  reviews?.close(); preparations?.close(); references?.close(); tasks?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
function feedback(id: string) {
  return POST(new Request('http://localhost/api/feedback', { method: 'POST', body: JSON.stringify({ content: '要点を追記' }) }), { params: Promise.resolve({ id }) });
}

it('AI-08/09 実StoreとrunNext・feedback入口で現在の資料だけを渡す', async () => {
  const task = tasks.create({ title: '資料の統合', aiPreparationRequired: true });
  const other = tasks.create({ title: '別タスク' });
  references.add(task.id, { kind: 'NOTE', body: '採用メモ本文' });
  references.add(other.id, { kind: 'NOTE', body: '別タスク専用本文' });
  const removed = references.add(task.id, { kind: 'NOTE', body: '削除メモ本文' });
  references.remove(task.id, removed.id);
  const url = references.add(task.id, { kind: 'URL', url: 'https://example.com/reference' });
  const attempt = references.beginFetch(task.id, url.id, 'fixture');
  references.finishFetch(task.id, url.id, attempt, { ok: true, title: '取得資料', body: '採用URL本文', contentType: 'text/plain', finalUrl: 'https://example.com/reference', truncated: false });
  preparations.enqueue(task, 'integration');
  expect((await preparations.runNext(tasks, runtime.get('active')!.preparationAdapter))?.status).toBe('SUCCEEDED');
  expect((await feedback(task.id)).status).toBe(201);
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain('採用メモ本文');
    expect(prompt).toContain('採用URL本文');
    expect(prompt).not.toContain('別タスク専用本文');
    expect(prompt).not.toContain('削除メモ本文');
  }
  references.remove(task.id, references.list(task.id).find(item => item.kind === 'NOTE')!.id);
  const retry = references.beginFetch(task.id, url.id, 'fixture');
  references.finishFetch(task.id, url.id, retry, { ok: false, code: 'TIMEOUT' });
  expect((await feedback(task.id)).status).toBe(201);
  expect(prompts[2]).not.toContain('採用メモ本文');
  expect(prompts[2]).not.toContain('採用URL本文');
  expect(prompts[2]).toContain('本文未取得');
  expect(preparations.listArtifacts(task.id)).toHaveLength(3);
});

it('AI-09 論理削除済タスクはrunNextとfeedbackから資料をAIへ渡さない', async () => {
  const task = tasks.create({ title: '削除するタスク', aiPreparationRequired: true });
  references.add(task.id, { kind: 'NOTE', body: '削除タスクの本文' });
  preparations.enqueue(task, 'deleted-task');
  tasks.delete(task.id);
  expect(references.list(task.id)).toHaveLength(1);
  expect((await preparations.runNext(tasks, runtime.get('active')!.preparationAdapter))?.status).toBe('CANCELLED');
  expect((await feedback(task.id)).status).toBe(404);
  expect(prompts).toEqual([]);
  expect(preparations.listArtifacts(task.id)).toEqual([]);
});

it('AI-11 feedbackのfallback reviseでも現在の資料と修正指示を転送する', async () => {
  const task = tasks.create({ title: '代替改訂', aiPreparationRequired: true });
  preparations.enqueue(task, 'initial');
  await preparations.runNext(tasks, new MockAiAdapter());
  references.add(task.id, { kind: 'NOTE', body: '改訂直前の追加メモ' });
  const fallback = new CliAiAdapter(async prompt => {
    prompts.push(prompt);
    return JSON.stringify({ steps: ['確認', '改訂'], draftMarkdown: '# 代替の改訂' });
  });
  const primary = { generate: async () => { throw new Error('synthetic failure'); }, revise: async () => { throw new Error('synthetic failure'); } };
  runtime.get('active')!.preparationAdapter = withReferences(new FallbackAiAdapter(primary, fallback), references);
  expect((await feedback(task.id)).status).toBe(201);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('改訂直前の追加メモ');
  expect(prompts[0]).toContain('要点を追記');
  expect(preparations.listArtifacts(task.id).at(-1)?.fallbackReason).toBeTruthy();
});

it('AI-BE-02 分解ジョブは実行直前の資料を使い版履歴とドラフトを維持する', async () => {
  const breakdown = new BreakdownStore(join(directory, 'db.sqlite'));
  try {
    const task = tasks.create({ title: '分解と資料の統合', aiPreparationRequired: true });
    preparations.enqueue(task, 'initial-breakdown');
    await preparations.runNext(tasks, new MockAiAdapter());
    breakdown.syncArtifacts(task.id, preparations);
    const imported = breakdown.snapshot(task.id).versions[0]!;
    const note = references.add(task.id, { kind: 'NOTE', body: 'キュー投入時のメモ' });
    const removed = references.add(task.id, { kind: 'NOTE', body: '削除した資料本文' });
    const other = tasks.create({ title: '別の分解' });
    references.add(other.id, { kind: 'NOTE', body: '別タスク資料本文' });
    const url = references.add(task.id, { kind: 'URL', url: 'https://example.com/breakdown' });
    const attempt = references.beginFetch(task.id, url.id, 'fixture');
    references.finishFetch(task.id, url.id, attempt, { ok: true, title: '分解参考', body: '分解URL本文', contentType: 'text/plain', finalUrl: 'https://example.com/breakdown', truncated: false });
    const command = { action: 'regenerate', baseVersion: imported.id, requestKey: 'with-reference', steps: ['未保存の手順'], comment: '資料を参考に確認を加える' };
    const secret = randomBytes(32).toString('hex');
    vi.stubEnv('SESSION_SECRET', secret);
    vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
    vi.stubEnv('AUTH_MODE', 'test');
    const handle = breakdownHandlers({ tasks, preparations, breakdown });
    const cookie = `task-planner-session=${createSessionToken(secret, 'owner@example.com')}`;
    const enqueue = await handle(new Request(`http://localhost/api/tasks/${task.id}/breakdown`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(command),
    }), task.id);
    expect(enqueue.status).toBe(202);
    references.edit(task.id, note.id, { title: '', body: '実行直前のメモ', revision: note.revision });
    references.remove(task.id, removed.id);
    const adapter = withReferences(new FallbackAiAdapter(new CliAiAdapter(async prompt => {
      prompts.push(prompt); return JSON.stringify({ steps: ['参考資料を確認する'] });
    }), new MockAiAdapter()), references);
    expect((await breakdown.runNext(tasks, preparations, adapter))?.status).toBe('SUCCEEDED');
    expect(prompts[0]).toContain('実行直前のメモ');
    expect(prompts[0]).toContain('分解URL本文');
    expect(prompts[0]).toContain('未保存の手順');
    expect(prompts[0]).toContain(command.comment);
    for (const excluded of ['キュー投入時のメモ', '削除した資料本文', '別タスク資料本文']) expect(prompts[0]).not.toContain(excluded);
    const generated = breakdown.snapshot(task.id).versions.at(-1)!;
    expect(generated).toMatchObject({ kind: 'ai', parentVersion: imported.id, steps: ['参考資料を確認する'], mode: 'ai' });
    const retry = references.beginFetch(task.id, url.id, 'fixture');
    references.finishFetch(task.id, url.id, retry, { ok: false, code: 'TIMEOUT' });
    breakdown.mutate(task.id, { ...command, baseVersion: generated.id, requestKey: 'failed-url' });
    expect((await breakdown.runNext(tasks, preparations, adapter))?.status).toBe('SUCCEEDED');
    expect(prompts[1]).toContain('本文未取得');
    expect(prompts[1]).not.toContain('分解URL本文');
    const beforeRestore = breakdown.snapshot(task.id).versions;
    breakdown.mutate(task.id, { action: 'restore', baseVersion: beforeRestore.at(-1)!.id, sourceVersion: imported.id, requestKey: 'restore-import' });
    expect(breakdown.snapshot(task.id).versions.at(-1)?.steps).toEqual(imported.steps);
    expect(breakdown.snapshot(task.id).versions.slice(0, -1)).toEqual(beforeRestore);
    expect(preparations.listArtifacts(task.id)).toHaveLength(1);
    expect(references.list(task.id)).toHaveLength(2);
  } finally { vi.unstubAllEnvs(); breakdown.close(); }
});
