import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { ReviewStore } from '../src/adapters/review-store';
import { MockAiAdapter } from '../src/adapters/mock-ai';
import { ReferenceStore } from '../src/adapters/reference-store';

function snapshot(db: Database.Database) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = z.array(z.object({ name: z.string().regex(/^[a-z_]+$/) })).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
  return { schema, rows: tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() })) };
}

it('MIG-02 初回追加前の既存スキーマ全体と保存データを維持する', async () => {
  const directory = mkdtempSync('/workspace/dev/tp-ref-data/reference-migration-');
  const path = join(directory, 'db.sqlite');
  const tasks = new TaskStore(path);
  const preparations = new PreparationStore(path, join(directory, 'artifacts'));
  const reviews = new ReviewStore(path);
  const db = new Database(path);
  let references: ReferenceStore | undefined;
  try {
    const task = tasks.create({ title: '移行前タスク', aiPreparationRequired: true });
    preparations.enqueue(task, 'before-migration');
    await preparations.runNext(tasks, new MockAiAdapter());
    await preparations.revise(task.id, '移行前の修正', tasks, new MockAiAdapter());
    reviews.rate(preparations.listArtifacts(task.id)[0].versionId, 'GOOD');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task_references'").get()).toBeUndefined();
    const before = snapshot(db);
    references = new ReferenceStore(path);
    const after = snapshot(db);
    expect(after.schema.filter(row => !z.object({ tbl_name: z.string() }).parse(row).tbl_name.startsWith('task_references'))).toEqual(before.schema);
    expect(after.rows.filter(row => row.name !== 'task_references')).toEqual(before.rows);
    expect(references.list(task.id)).toEqual([]);
    expect(references.add(task.id, { kind: 'NOTE', body: '移行後に保存' }).body).toBe('移行後に保存');
  } finally {
    references?.close(); db.close(); reviews.close(); preparations.close(); tasks.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
