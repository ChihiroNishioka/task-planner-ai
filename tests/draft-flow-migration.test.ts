import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { BreakdownStore } from '../src/adapters/breakdown-store';
import { DraftFlowStore } from '../src/adapters/draft-flow-store';
import { MockAiAdapter } from '../src/adapters/mock-ai';

it.each(['none', 'before', 'after'])('DF-M01/02/03/05 completed_at %sでも既存行を書き換えない', async column => {
  const directory = mkdtempSync(join(tmpdir(), 'draft-migrate-')); const path = join(directory, 'db.sqlite');
  const tasks = new TaskStore(path); const preparations = new PreparationStore(path, join(directory, 'artifacts')); const breakdown = new BreakdownStore(path); const db = new Database(path);
  let flow: DraftFlowStore | undefined;
  try {
    const task = tasks.create({ title: '移行前' }); preparations.enqueue(task); await preparations.runNext(tasks, new MockAiAdapter()); breakdown.syncArtifacts(task.id, preparations);
    if (column === 'before') db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
    const tables = ['tasks', 'preparation_jobs', 'work_plans', 'artifacts', 'artifact_versions', 'feedback', 'breakdown_versions', 'breakdown_requests', 'breakdown_jobs'];
    const before = tables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
    flow = new DraftFlowStore(path, join(directory, 'artifacts'));
    expect(tables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())).toEqual(before);
    expect(flow.snapshot(task.id).draft?.version).toBe(1);
    flow.close(); flow = undefined;
    if (column === 'after') db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
    flow = new DraftFlowStore(path, join(directory, 'artifacts')); expect(flow.snapshot(task.id).draft?.tracking).toBe('INFERRED');
  } finally { flow?.close(); db.close(); breakdown.close(); preparations.close(); tasks.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('DF-M04 起動順と繰り返しでsqlite_masterが一致する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'draft-schema-'));
  const schemas = [true, false].map(breakdownFirst => {
    const path = join(directory, `${breakdownFirst}.sqlite`); const tasks = new TaskStore(path); const preparation = new PreparationStore(path, join(directory, 'artifacts'));
    const stores = breakdownFirst ? [new BreakdownStore(path), new DraftFlowStore(path, join(directory, 'artifacts'))] : [new DraftFlowStore(path, join(directory, 'artifacts')), new BreakdownStore(path)];
    stores.forEach(store => store.close());
    const again = new DraftFlowStore(path, join(directory, 'artifacts')); again.close();
    const db = new Database(path); const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(z.array(z.object({ name: z.string() })).parse(schema).some(row => row.name === 'draft_jobs')).toBe(true);
    db.close(); preparation.close(); tasks.close(); return schema;
  });
  try { expect(schemas[0]).toEqual(schemas[1]); } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('DF-M06 通常Shell専用。2プロセス同時初期化が成功する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'draft-processes-')); const path = join(directory, 'db.sqlite'); const tasks = new TaskStore(path); const preparations = new PreparationStore(path, join(directory, 'artifacts')); const breakdown = new BreakdownStore(path); tasks.close(); preparations.close(); breakdown.close();
  const children = Array.from({ length: 2 }, () => fork(join(process.cwd(), 'tests/fixtures/draft-flow-migration-child.mjs'), [path, join(directory, 'artifacts')], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], timeout: 6000 }));
  try {
    const ready = children.map(child => new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('message', () => resolve()); child.once('exit', code => reject(new Error(`子プロセス早期終了 ${code}`))); }));
    const exits = children.map(child => new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }));
    await Promise.all(ready); children.forEach(child => child.send('go')); expect(await Promise.all(exits)).toEqual([0, 0]);
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); rmSync(directory, { recursive: true, force: true }); }
}, 10_000);
it('DF-M07 新表があっても旧経路はdraft_jobsを処理しない', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'draft-legacy-')); const path = join(directory, 'db.sqlite'); const tasks = new TaskStore(path); const preparations = new PreparationStore(path, join(directory, 'artifacts')); const breakdown = new BreakdownStore(path); const flow = new DraftFlowStore(path, join(directory, 'artifacts'));
  try {
    const task = tasks.create({ title: '旧経路' }); const version = breakdown.mutate(task.id, { action: 'save', steps: ['読む'], baseVersion: null, requestKey: 'save' }).versions[0];
    const job = flow.enqueue(task.id, version.id, 'draft'); preparations.enqueue(tasks.get(task.id)!); await preparations.runNext(tasks, new MockAiAdapter()); await preparations.revise(task.id, '補足する', tasks, new MockAiAdapter());
    expect(preparations.listArtifacts(task.id)).toHaveLength(2); expect(flow.snapshot(task.id).job).toMatchObject({ id: job.id, status: 'QUEUED' });
  } finally { flow.close(); breakdown.close(); preparations.close(); tasks.close(); rmSync(directory, { recursive: true, force: true }); }
});
