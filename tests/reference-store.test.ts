import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ReferenceStore } from '../src/adapters/reference-store';
import { TaskStore } from '../src/adapters/task-store';

let dir: string;
let store: ReferenceStore;
let tasks: TaskStore;
let id: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'references-'));
  tasks = new TaskStore(join(dir, 'db.sqlite'));
  id = tasks.create({ title: '資料の確認' }).id;
  store = new ReferenceStore(join(dir, 'db.sqlite'));
});
afterEach(() => { store?.close(); tasks?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('NOTE-01/02/03/06/07 保存・再起動・競合・他タスク分離・削除', () => {
  const originalRevision = tasks.get(id)?.revision;
  const note = store.add(id, { kind: 'NOTE', title: '題名', body: '本文' }, 'one');
  store.close(); store = new ReferenceStore(join(dir, 'db.sqlite'));
  expect(store.list(id)).toEqual([note]);
  expect(() => store.edit('other', note.id, { body: '別', revision: 1 })).toThrow();
  expect(store.edit(id, note.id, { title: '新', body: '更新', revision: 1 })).toMatchObject({ revision: 2, body: '更新' });
  expect(() => store.edit(id, note.id, { body: '古い', revision: 1 })).toThrow();
  expect(store.list(id)[0]?.body).toBe('更新');
  expect(tasks.get(id)?.revision).toBe(originalRevision);
  expect(() => store.remove('other', note.id)).toThrow();
  store.remove(id, note.id);
  expect(store.list(id)).toEqual([]);
  expect(() => store.remove(id, note.id)).toThrow();
});
it('NOTE-04/05 本文上限と冪等キー', () => {
  expect(() => store.add(id, { kind: 'NOTE', body: '' })).toThrow();
  expect(() => store.add(id, { kind: 'NOTE', body: 'あ'.repeat(20_001) })).toThrow();
  const note = store.add(id, { kind: 'NOTE', body: 'あ'.repeat(20_000) }, 'same');
  expect(store.add(id, { kind: 'NOTE', body: 'あ'.repeat(20_000) }, 'same')).toEqual(note);
  expect(() => store.add(id, { kind: 'NOTE', body: '別' }, 'same')).toThrow();
  expect(store.list(id)).toHaveLength(1);
});
it('URL-03/04/10 古い取得は反映せず失敗時の旧本文は保持、削除で復活しない', () => {
  const url = store.add(id, { kind: 'URL', url: 'https://example.com/' });
  const first = store.beginFetch(id, url.id, 'live');
  expect(() => store.beginFetch(id, url.id, 'live')).toThrow();
  store.finishFetch(id, url.id, first, { ok: true, title: 'ページ', body: '前回本文', contentType: 'text/html', finalUrl: 'https://example.com/', truncated: false });
  const second = store.beginFetch(id, url.id, 'fixture');
  store.finishFetch(id, url.id, first, { ok: false, code: 'NETWORK_ERROR' });
  expect(store.get(id, url.id)).toMatchObject({ fetchStatus: 'FETCHING' });
  store.finishFetch(id, url.id, second, { ok: false, code: 'TIMEOUT' });
  expect(store.get(id, url.id)).toMatchObject({ body: '前回本文', fetchStatus: 'FAILED', fetchErrorCode: 'TIMEOUT' });
  const third = store.beginFetch(id, url.id, 'live');
  store.remove(id, url.id);
  store.finishFetch(id, url.id, third, { ok: false, code: 'NETWORK_ERROR' });
  expect(store.list(id)).toEqual([]);
});
it('URL-11 中断を復旧し再取得できる', () => {
  const url = store.add(id, { kind: 'URL', url: 'https://example.com/' });
  store.beginFetch(id, url.id, 'live');
  const db = new Database(join(dir, 'db.sqlite'));
  db.prepare("UPDATE task_references SET fetch_started_at = ?").run(new Date(Date.now() - 31_000).toISOString());
  db.close();
  expect(store.get(id, url.id)).toMatchObject({ fetchStatus: 'FAILED', fetchErrorCode: 'INTERRUPTED' });
  expect(store.beginFetch(id, url.id, 'live')).toBeTypeOf('string');
});
it('MIG-01/02/03 既存のスキーマと行は不変、複数Store初期化', () => {
  const db = new Database(join(dir, 'db.sqlite'));
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get();
  const rows = db.prepare('SELECT * FROM tasks').all();
  const another = new ReferenceStore(join(dir, 'db.sqlite'));
  another.close();
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get()).toEqual(before);
  expect(db.prepare('SELECT * FROM tasks').all()).toEqual(rows);
  db.close();
});
