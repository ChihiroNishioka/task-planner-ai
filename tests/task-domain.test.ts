import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTaskCandidates, taskInputSchema } from '../src/domain/task';
import { TaskStore } from '../src/adapters/task-store';

describe('Phase 1 task handling', () => {
  let directory: string;
  let store: TaskStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'task-planner-'));
    store = new TaskStore(join(directory, 'tasks.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('T-01-01 extracts three reviewable task candidates from one utterance', () => {
    const tasks = extractTaskCandidates({
      text: '明日までに田中さんへ返信して、金曜日までにAIの構想をまとめて、あと牛乳を買う',
      now: new Date('2026-11-11T15:00:00.000Z'),
    });
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ title: expect.stringContaining('返信'), deadline: '2026-11-13' });
    expect(tasks[1]).toMatchObject({ taskType: 'SOLUTION_DESIGN', deadline: '2026-11-13' });
    expect(tasks[2]).toMatchObject({ deadline: null });
  });

  it('T-01-02 rejects invalid input without creating a task', () => {
    expect(taskInputSchema.safeParse({ title: '', deadline: 'not-a-date' }).success).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('T-01-03 resolves relative dates by Tokyo calendar day across midnight', () => {
    const before = extractTaskCandidates({ text: '明日までに資料を出す', now: new Date('2026-11-11T14:59:59.000Z') });
    const after = extractTaskCandidates({ text: '明日までに資料を出す', now: new Date('2026-11-11T15:00:00.000Z') });
    expect(before[0]?.deadline).toBe('2026-11-12');
    expect(after[0]?.deadline).toBe('2026-11-13');
  });

  it('T-01-04 produces the same Tokyo date regardless of host timezone', () => {
    const tasks = extractTaskCandidates({ text: '明日までに資料を出す', now: new Date('2026-11-11T15:00:00.000Z') });
    expect(tasks[0]?.deadline).toBe('2026-11-13');
  });

  it('T-01-05 makes concurrent retries with one operation key create one task', async () => {
    const input = { title: '資料を整理する', originalInput: '資料を整理する' };
    const created = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(store.create(input, 'same-operation'))));
    expect(new Set(created.map((task) => task.id)).size).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('T-01-06 keeps tasks after the store is reopened', () => {
    store.create({ title: '再起動後も残す', originalInput: '再起動後も残す' }, 'persist-operation');
    store.close();
    store = new TaskStore(join(directory, 'tasks.sqlite'));
    expect(store.list().map((task) => task.title)).toEqual(['再起動後も残す']);
  });

  it('updates task fields and keeps completion, postponement, and deletion inside the app', () => {
    const task = store.create({ title: '更新する', originalInput: '更新する' }, 'edit-operation');
    expect(store.rename(task.id, '変更後')).toMatchObject({ title: '変更後', revision: 2 });
    expect(store.postpone(task.id, '2026-12-01')?.deadline).toBe('2026-12-01');
    expect(store.updateStatus(task.id, 'COMPLETED')?.status).toBe('COMPLETED');
    expect(store.delete(task.id)).toBe(true);
    expect(store.get(task.id)).toBeNull();
  });
});
