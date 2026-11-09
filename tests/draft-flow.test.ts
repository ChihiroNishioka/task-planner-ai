import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/domain/task';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { DraftFlowStore } from '../src/adapters/draft-flow-store';
import { MockAiAdapter, type PreparationAdapter } from '../src/adapters/mock-ai';

let directory: string, path: string;
let tasks: TaskStore, preparations: PreparationStore, breakdown: BreakdownStore, flow: DraftFlowStore, db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'draft-flow-')); path = join(directory, 'db.sqlite');
  tasks = new TaskStore(path); preparations = new PreparationStore(path, join(directory, 'artifacts')); breakdown = new BreakdownStore(path); flow = new DraftFlowStore(path, join(directory, 'artifacts')); db = new Database(path);
});
afterEach(() => { db.close(); flow.close(); breakdown.close(); preparations.close(); tasks.close(); rmSync(directory, { recursive: true, force: true }); });
const mock = () => new MockAiAdapter();
function saved(steps = ['資料を読む', '提案を書く']) {
  const task = tasks.create({ title: '架空の提案' });
  const version = breakdown.mutate(task.id, { action: 'save', steps, baseVersion: null, requestKey: randomUUID() }).versions.at(-1)!;
  return { task, version };
}
function edit(taskId: string, steps: string[]) {
  return breakdown.mutate(taskId, { action: 'save', steps, baseVersion: breakdown.snapshot(taskId).versions.at(-1)?.id ?? null, requestKey: randomUUID() }).versions.at(-1)!;
}
async function drafted() { const data = saved(); flow.enqueue(data.task.id, data.version.id, 'create'); await flow.runNextDraft(tasks, mock()); return data; }
function delayedDraft(effect: () => void): PreparationAdapter {
  return { generate: task => mock().generate(task), createDraft: async (task, steps) => { effect(); return mock().createDraft(task, steps); } };
}
it('DF-U03 初回は分解版のみを作りREADYにする', async () => {
  const task = tasks.create({ title: '初回分解' }); preparations.enqueue(task);
  const generate = vi.fn(); const adapter = mock(); adapter.generate = generate;
  expect((await flow.runNextPreparation(tasks, adapter))?.status).toBe('SUCCEEDED');
  expect(breakdown.snapshot(task.id).versions).toMatchObject([{ kind: 'ai', comment: '', mode: 'mock' }]);
  expect(breakdown.snapshot(task.id).versions[0].label).toContain('初回作成');
  expect(preparations.listArtifacts(task.id)).toHaveLength(0); expect(tasks.get(task.id)?.aiStatus).toBe('READY'); expect(generate).not.toHaveBeenCalled();
});
it('DF-U05 初回実行中に保存した分解を守る', async () => {
  const task = tasks.create({ title: '初回競合' }); preparations.enqueue(task);
  const adapter: PreparationAdapter = { generate: task => mock().generate(task), initialBreakdown: async task => { edit(task.id, ['利用者の編集']); return mock().initialBreakdown(task); } };
  expect(await flow.runNextPreparation(tasks, adapter)).toMatchObject({ status: 'FAILED', errorCode: 'BREAKDOWN_CHANGED' });
  expect(breakdown.snapshot(task.id).versions.at(-1)?.steps).toEqual(['利用者の編集']);
});
it('DF-U12/13/14/15/29 改訂は分解を変えず基準版を引き継ぎ同期でも取り込まない', async () => {
  const { task, version } = await drafted();
  expect(flow.snapshot(task.id).draft).toMatchObject({ basedOnVersionId: version.id, tracking: 'TRACKED' });
  edit(task.id, ['最新の編集']); expect(flow.snapshot(task.id).stale).toBe(true);
  const before = breakdown.snapshot(task.id).versions;
  const adapter: PreparationAdapter = { generate: task => mock().generate(task), reviseDraft: async (task, previous, feedback) => { const result = await mock().revise(task, previous, feedback); return { ...result, plan: { ...result.plan, steps: ['AIが勝手に変えた分解'] } }; } };
  const result = await flow.reviseDraft(task.id, '短くする', tasks, adapter);
  expect(result.plan.steps).toEqual(['最新の編集']); expect(flow.snapshot(task.id).stale).toBe(true);
  expect(flow.snapshot(task.id).draft?.basedOnVersionId).toBe(version.id);
  for (let i = 0; i < 3; i++) { breakdown.syncArtifacts(task.id, preparations); expect(breakdown.snapshot(task.id).versions).toEqual(before); }
  const same = edit(task.id, version.steps); expect(flow.snapshot(task.id).stale).toBe(false);
  flow.enqueue(task.id, same.id, 'again'); await flow.runNextDraft(tasks, mock()); expect(flow.snapshot(task.id).stale).toBe(false);
});
it('DF-U16 旧ドラフトはINFERREDかUNKNOWNで読み取りは書き込まない', async () => {
  const task = tasks.create({ title: '旧版' }); preparations.enqueue(task); await preparations.runNext(tasks, mock());
  expect(flow.snapshot(task.id).draft?.tracking).toBe('UNKNOWN');
  breakdown.syncArtifacts(task.id, preparations);
  const before = db.prepare('SELECT * FROM breakdown_versions').all();
  expect(flow.snapshot(task.id).draft?.tracking).toBe('INFERRED'); expect(flow.snapshot(task.id).stale).toBe(false);
  expect(db.prepare('SELECT * FROM breakdown_versions').all()).toEqual(before); expect(db.prepare('SELECT * FROM draft_version_links').all()).toHaveLength(0);
});
it('DF-U17 版違い・空・不正・準備・再生成・終了を拒否する', () => {
  const { task, version } = saved();
  expect(() => flow.enqueue(task.id, randomUUID(), 'wrong')).toThrow(/分解が更新/);
  edit(task.id, []); expect(() => flow.enqueue(task.id, breakdown.snapshot(task.id).versions.at(-1)!.id, 'empty')).toThrow(/1件以上/);
  const invalid = edit(task.id, ['正しい項目']);
  db.prepare('UPDATE breakdown_versions SET data_json = ? WHERE id = ?').run(JSON.stringify({ ...invalid, steps: ['a'.repeat(301)] }), invalid.id);
  expect(() => flow.enqueue(task.id, invalid.id, 'invalid')).toThrow(/1〜300字/);
  const current = edit(task.id, version.steps); preparations.enqueue(tasks.get(task.id)!);
  expect(() => flow.enqueue(task.id, current.id, 'preparing')).toThrow(/分解を作成中/);
  db.prepare("UPDATE preparation_jobs SET status='CANCELLED'").run();
  breakdown.mutate(task.id, { action: 'regenerate', steps: current.steps, comment: '直す', baseVersion: current.id, requestKey: 'regen' });
  expect(() => flow.enqueue(task.id, current.id, 'busy')).toThrow(/分解を作成中/);
  tasks.updateStatus(task.id, 'COMPLETED'); expect(() => flow.enqueue(task.id, current.id, 'closed')).toThrow(/完了・中止/);
  tasks.delete(task.id); expect(() => flow.enqueue(task.id, current.id, 'deleted')).toThrow();
});
it('DF-U18 別接続6件の受付は1件だけで同一キーの再送を保持する', async () => {
  const { task, version } = saved();
  const stores = Array.from({ length: 6 }, () => new DraftFlowStore(path, join(directory, 'artifacts')));
  try {
    const results = await Promise.allSettled(stores.map((store, i) => Promise.resolve().then(() => store.enqueue(task.id, version.id, `parallel-${i}`))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const existing = flow.snapshot(task.id).job!;
    expect(flow.enqueue(task.id, version.id, 'parallel-0').id).toBe(existing.id);
    expect(() => flow.enqueue(task.id, randomUUID(), 'parallel-0')).toThrow(/別の内容/);
  } finally { stores.forEach(store => store.close()); }
});
it('DF-U19 作成中の分解変更ではartifactとファイルを作らない', async () => {
  const { task, version } = saved(); flow.enqueue(task.id, version.id, 'start');
  expect(await flow.runNextDraft(tasks, delayedDraft(() => edit(task.id, ['変更後'])))).toMatchObject({ status: 'FAILED', errorCode: 'BREAKDOWN_CHANGED' });
  expect(preparations.listArtifacts(task.id)).toHaveLength(0); expect(readdirSync(join(directory, 'artifacts'))).toHaveLength(0);
});
it.each(['COMPLETED', 'DELETED'])('DF-U20 %sを取得前/実行中とも保存しない', async status => {
  for (const during of [false, true]) {
    const { task, version } = saved(); flow.enqueue(task.id, version.id, 'start');
    const change = () => status === 'DELETED' ? tasks.delete(task.id) : tasks.updateStatus(task.id, 'COMPLETED');
    if (!during) change();
    const createDraft = vi.fn(async (input: Task, steps: string[]) => { change(); return mock().createDraft(input, steps); });
    expect(await flow.runNextDraft(tasks, { generate: input => mock().generate(input), createDraft })).toMatchObject({ status: 'CANCELLED', errorCode: 'TASK_NOT_RUNNABLE' });
    if (!during) expect(createDraft).not.toHaveBeenCalled();
    expect(preparations.listArtifacts(task.id)).toHaveLength(0);
  }
});
it('DF-U21 実行中の取消は生成結果を保存しない', async () => {
  const { task, version } = saved(); const job = flow.enqueue(task.id, version.id, 'start');
  expect(await flow.runNextDraft(tasks, delayedDraft(() => { flow.cancel(task.id, job.id); }))).toMatchObject({ status: 'CANCELLED' });
  expect(preparations.listArtifacts(task.id)).toHaveLength(0);
});
it('DF-U22 生成失敗は既存ドラフトとtasksを保持する', async () => {
  const { task, version } = await drafted(); const before = tasks.get(task.id);
  flow.enqueue(task.id, version.id, 'failure');
  expect(await flow.runNextDraft(tasks, { generate: input => mock().generate(input), createDraft: async () => { throw new Error('生成失敗'); } })).toMatchObject({ status: 'FAILED', errorCode: 'GENERATION_FAILED' });
  expect(preparations.listArtifacts(task.id)).toHaveLength(1); expect(tasks.get(task.id)).toEqual(before);
});
it('DF-U23 15分超のRUNNINGを失敗にする', async () => {
  const { task, version } = saved(); const job = flow.enqueue(task.id, version.id, 'old');
  db.prepare("UPDATE draft_jobs SET status='RUNNING', updated_at=? WHERE id=?").run(new Date(Date.now() - 16 * 60_000).toISOString(), job.id);
  await flow.runNextDraft(tasks, mock()); expect(flow.snapshot(task.id).job).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_INTERRUPTED' });
});
it('DF-U24 作成中の改訂は拒否し改訂でrevisionと再生成ジョブを変えない', async () => {
  const { task, version } = await drafted(); const job = flow.enqueue(task.id, version.id, 'new');
  await expect(flow.reviseDraft(task.id, '修正', tasks, mock())).rejects.toMatchObject({ code: 'DRAFT_JOB_ACTIVE' }); flow.cancel(task.id, job.id);
  breakdown.mutate(task.id, { action: 'regenerate', steps: version.steps, comment: '改善', baseVersion: version.id, requestKey: 'regenerate' });
  const before = tasks.get(task.id); await flow.reviseDraft(task.id, '修正', tasks, mock());
  expect(tasks.get(task.id)).toEqual(before); expect(breakdown.snapshot(task.id).jobs[0].status).toBe('QUEUED');
});
it.each([false, true])('DF-U27/28 完了→再開のrevision変化を検査する during=%s', async during => {
  const { task, version } = saved(); flow.enqueue(task.id, version.id, 'start');
  const change = () => { tasks.updateStatus(task.id, 'COMPLETED'); tasks.updateStatus(task.id, 'OPEN'); };
  if (!during) change();
  const createDraft = vi.fn(async (input: Task, steps: string[]) => { if (during) change(); return mock().createDraft(input, steps); });
  expect(await flow.runNextDraft(tasks, { generate: input => mock().generate(input), createDraft })).toMatchObject({ status: 'FAILED', errorCode: 'TASK_CHANGED' });
  if (!during) expect(createDraft).not.toHaveBeenCalled(); expect(preparations.listArtifacts(task.id)).toHaveLength(0);
});
it.each(['delete', 'complete', 'rename', 'concurrent'])('DF-U30 改訂待機中の%sを保存前に検査する', async action => {
  const { task } = await drafted();
  const adapter: PreparationAdapter = { generate: input => mock().generate(input), reviseDraft: async (input, previous, feedback, steps) => {
    if (action === 'delete') tasks.delete(task.id);
    if (action === 'complete') tasks.updateStatus(task.id, 'COMPLETED');
    if (action === 'rename') tasks.rename(task.id, '変更後');
    if (action === 'concurrent') await flow.reviseDraft(task.id, '先行', tasks, mock());
    return mock().reviseDraft(input, previous, feedback, steps);
  } };
  await expect(flow.reviseDraft(task.id, '修正', tasks, adapter)).rejects.toThrow(/[ぁ-んァ-ヶ一-龯]/);
  expect(preparations.listArtifacts(task.id)).toHaveLength(action === 'concurrent' ? 2 : 1);
  expect(preparations.feedbackHistory(task.id)).toHaveLength(action === 'concurrent' ? 1 : 0);
});
it('DF-U31 完了中は作れず、完了から戻すと completed_at が消えて作れる（PR #9 の changeStatus）', async () => {
  const { task, version } = saved();
  const done = tasks.changeStatus(task.id, 'COMPLETED');
  expect(done?.task.completedAt).toBeTruthy();
  expect(flow.snapshot(task.id)).toMatchObject({ canCreate: false, blockReason: 'TASK_NOT_RUNNABLE' });
  const reopened = tasks.changeStatus(task.id, 'OPEN');
  expect(reopened?.task.completedAt).toBeNull();
  expect(flow.snapshot(task.id)).toMatchObject({ canCreate: true, blockReason: null });
  flow.enqueue(task.id, version.id, 'reopened');
  expect(await flow.runNextDraft(tasks, mock())).toMatchObject({ status: 'SUCCEEDED' });
});
