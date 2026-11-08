import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { TaskStore } from '../src/adapters/task-store';
import { ReferenceStore } from '../src/adapters/reference-store';

function message(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('子プロセス応答期限超過')), 4000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`子プロセス早期終了 ${code}`)); });
    child.once('message', value => {
      clearTimeout(timer);
      if (value === expected) resolve();
      else reject(new Error('子プロセス応答不一致'));
    });
  });
}

it('MIG-03 通常Shell専用。別プロセスの初回初期化が同じDB書込ロック下で競合する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-migration-race-'));
  const path = join(directory, 'db.sqlite');
  const tasks = new TaskStore(path);
  const task = tasks.create({ title: '競合前のタスク' });
  tasks.close();
  const db = new Database(path);
  const children: ChildProcess[] = [];
  let locked = false;
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task_references'").get()).toBeUndefined();
    db.exec('BEGIN IMMEDIATE'); locked = true;
    for (let i = 0; i < 2; i++) {
      children.push(fork(join(process.cwd(), 'tests/fixtures/reference-migration-child.mjs'), [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], timeout: 6000 }));
    }
    const exits = children.map(child => once(child, 'exit'));
    await Promise.all(children.map(child => message(child, 'ready')));
    const starting = children.map(child => message(child, 'starting'));
    for (const child of children) child.send('go');
    await Promise.all(starting);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(children.map(child => child.exitCode)).toEqual([null, null]);
    expect(children.map(child => child.connected)).toEqual([true, true]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task_references'").get()).toBeUndefined();
    db.exec('COMMIT'); locked = false;
    expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
    expect(db.prepare('SELECT title FROM tasks WHERE id=?').get(task.id)).toEqual({ title: task.title });
    const references = new ReferenceStore(path);
    try { expect(references.add(task.id, { kind: 'NOTE', body: '競合後に保存' }).body).toBe('競合後に保存'); }
    finally { references.close(); }
  } finally {
    if (locked) db.exec('ROLLBACK');
    for (const child of children) if (child.exitCode === null) child.kill();
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
