import Database from 'better-sqlite3';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { DraftFlowStore } from '../src/adapters/draft-flow-store';
import { MockAiAdapter } from '../src/adapters/mock-ai';
import { draftJobSchema } from '../src/domain/draft-flow';

const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('enqueued'), jobId: z.string() }),
  z.object({ kind: z.literal('worked'), job: draftJobSchema.nullable() }),
  z.object({ kind: z.literal('revised'), versionId: z.string() }),
  z.object({ kind: z.literal('revision-conflict') }),
]);
type Operation = 'enqueue' | 'work' | 'revise' | 'create';
let directory: string;
let path: string;
let tasks: TaskStore;
let preparations: PreparationStore;
let breakdown: BreakdownStore;
let flow: DraftFlowStore;
let db: Database.Database;
const children: ChildProcess[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'draft-processes-'));
  path = join(directory, 'db.sqlite');
  tasks = new TaskStore(path);
  preparations = new PreparationStore(path, join(directory, 'artifacts'));
  breakdown = new BreakdownStore(path);
  flow = new DraftFlowStore(path, join(directory, 'artifacts'));
  db = new Database(path);
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, 2000);
    const stopped = () => { clearTimeout(timer); resolve(); };
    child.once('exit', stopped);
    child.once('error', stopped);
    child.kill('SIGKILL');
  })));
  db.close(); flow.close(); breakdown.close(); preparations.close(); tasks.close();
  rmSync(directory, { recursive: true, force: true });
});

function saved() {
  const task = tasks.create({ title: '架空の提案' });
  const version = breakdown.mutate(task.id, { action: 'save', steps: ['資料を読む', '提案を書く'], baseVersion: null, requestKey: 'save' }).versions[0];
  return { task, version };
}

function start(operation: Operation, taskId: string, versionId: string) {
  const child = fork(join(process.cwd(), 'tests/fixtures/draft-flow-process-child.mjs'), [path, join(directory, 'artifacts'), operation, taskId, versionId], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], timeout: 10_000, killSignal: 'SIGKILL',
  });
  children.push(child);
  let markReady: () => void = () => {};
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const done = new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
    let result: z.infer<typeof resultSchema> | undefined;
    child.on('message', (message: unknown) => {
      if (z.object({ kind: z.literal('ready') }).safeParse(message).success) markReady();
      else {
        const parsed = resultSchema.safeParse(message);
        if (parsed.success) result = parsed.data;
        else reject(new Error('子プロセスの結果形式が不正です。'));
      }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`子プロセス失敗 code=${code} signal=${signal}`));
    });
  });
  // ready 待機中の起動失敗も即座に伝え、未処理の rejection を残さない。
  const started = Promise.race([ready, done.then(() => { throw new Error('開始合図より前に子が終了しました。'); })]);
  void done.catch(() => {});
  return { child, ready: started, done };
}

async function race(operations: [Operation, Operation], taskId: string, versionId: string) {
  const pair = operations.map(operation => start(operation, taskId, versionId));
  await Promise.all(pair.map(child => child.ready));
  pair.forEach(({ child }) => child.send('go'));
  return Promise.all(pair.map(child => child.done));
}

function expectFiles(taskId: string, count: number) {
  const artifacts = preparations.listArtifacts(taskId);
  expect(artifacts.map(artifact => artifact.version).sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
  expect(new Set(artifacts.map(artifact => artifact.versionId)).size).toBe(count);
  expect(new Set(artifacts.map(artifact => artifact.path)).size).toBe(count);
  for (const artifact of artifacts) expect(readFileSync(artifact.path, 'utf8')).toBe(artifact.content);
  expect(readdirSync(join(directory, 'artifacts'))).toHaveLength(count);
}

it('DF-P01 通常Shell専用。既存の守りを確認。同一キーを2プロセスで同時受付しても1ジョブ', async () => {
  const { task, version } = saved();
  const results = await race(['enqueue', 'enqueue'], task.id, version.id);
  const ids = results.map(result => { expect(result.kind).toBe('enqueued'); return result.kind === 'enqueued' ? result.jobId : null; });
  expect(new Set(ids).size).toBe(1);
  expect(db.prepare('SELECT id FROM draft_jobs WHERE task_id=?').all(task.id)).toEqual([{ id: ids[0] }]);
  expect(flow.snapshot(task.id).job).toMatchObject({ id: ids[0], status: 'QUEUED' });
}, 20_000);

it('DF-P02 通常Shell専用。既存の守りを確認。2プロセスのworkerが同じジョブを二重に取らない', async () => {
  const { task, version } = saved();
  const job = flow.enqueue(task.id, version.id, 'start');
  const results = await race(['work', 'work'], task.id, version.id);
  expect(results.filter(result => result.kind === 'worked' && result.job === null)).toHaveLength(1);
  expect(results.filter(result => result.kind === 'worked' && result.job?.status === 'SUCCEEDED')).toHaveLength(1);
  expect(db.prepare('SELECT id,status FROM draft_jobs WHERE task_id=?').all(task.id)).toEqual([{ id: job.id, status: 'SUCCEEDED' }]);
  expectFiles(task.id, 1);
}, 20_000);

it('DF-P03 通常Shell専用。既存の守りを確認。改訂保存とworker作成を競わせても版とファイルが欠けない', async () => {
  const { task, version } = saved();
  flow.enqueue(task.id, version.id, 'initial');
  await flow.runNextDraft(tasks, new MockAiAdapter());
  const initial = preparations.listArtifacts(task.id)[0];
  const results = await race(['revise', 'create'], task.id, version.id);
  const revision = results[0];
  expect(['revised', 'revision-conflict']).toContain(revision.kind);
  expect(results[1]).toMatchObject({ kind: 'worked', job: { status: 'SUCCEEDED' } });
  expectFiles(task.id, revision.kind === 'revised' ? 3 : 2);
  expect(preparations.listArtifacts(task.id).find(artifact => artifact.versionId === initial.versionId)).toEqual(initial);
  expect(preparations.feedbackHistory(task.id)).toHaveLength(revision.kind === 'revised' ? 1 : 0);
}, 20_000);
