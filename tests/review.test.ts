import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAiAdapter } from '../src/adapters/mock-ai';
import { PreparationStore } from '../src/adapters/preparation-store';
import { ReviewStore } from '../src/adapters/review-store';
import { TaskStore } from '../src/adapters/task-store';

describe('Phase 5 feedback and quality reuse', () => {
  let directory: string;
  let tasks: TaskStore;
  let preparations: PreparationStore;
  let reviews: ReviewStore;
  let taskId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'task-planner-review-'));
    const databasePath = join(directory, 'tasks.sqlite');
    tasks = new TaskStore(databasePath);
    preparations = new PreparationStore(databasePath, join(directory, 'artifacts'));
    reviews = new ReviewStore(databasePath);
    const task = tasks.create({ title: '問い合わせ改善の構想', originalInput: '回答作業を効率化する', category: 'WORK' }, 'review-task');
    taskId = task.id;
    preparations.enqueue(task, 'initial-draft');
    await preparations.runNext(tasks, new MockAiAdapter());
  });
  afterEach(() => { tasks.close(); preparations.close(); reviews.close(); rmSync(directory, { recursive: true, force: true }); });

  it('T-08-01 creates v2 from feedback and keeps v1 immutable', async () => {
    const first = preparations.listArtifacts(taskId)[0]!;
    const second = await preparations.revise(taskId, '結論を先に書いてください', tasks, new MockAiAdapter());
    expect(second).toMatchObject({ version: 2, parentVersionId: first.versionId, mode: 'mock' });
    expect(readFileSync(first.path, 'utf8')).not.toContain('結論を先に書いてください');
    expect(readFileSync(second.path, 'utf8')).toContain('結論を先に書いてください');
    expect(preparations.feedbackHistory(taskId)).toHaveLength(1);
  });

  it('T-09-01 keeps Good and Bad ratings on their own versions', async () => {
    const first = preparations.listArtifacts(taskId)[0]!;
    const second = await preparations.revise(taskId, '例を追加してください', tasks, new MockAiAdapter());
    reviews.rate(first.versionId, 'BAD');
    reviews.rate(second.versionId, 'GOOD');
    expect(reviews.rating(first.versionId)).toBe('BAD');
    expect(reviews.rating(second.versionId)).toBe('GOOD');
  });

  it('T-09-02 approves a saved final version without completing the task', () => {
    const first = preparations.listArtifacts(taskId)[0]!;
    reviews.rate(first.versionId, 'GOOD');
    reviews.approveFinal(first.versionId);
    expect(reviews.approval(first.versionId)).toBe('APPROVED');
    expect(reviews.rating(first.versionId)).toBe('GOOD');
    expect(tasks.get(taskId)?.status).toBe('OPEN');
  });

  it('T-10-01 reuses Good drafts only within the same data category', async () => {
    const first = preparations.listArtifacts(taskId)[0]!;
    reviews.rate(first.versionId, 'GOOD');
    const other = tasks.create({ title: '学習用の問い合わせ課題', originalInput: '問い合わせの課題', category: 'STUDY' }, 'study-task');
    preparations.enqueue(other, 'study-draft');
    await preparations.runNext(tasks, new MockAiAdapter());
    const otherVersion = preparations.listArtifacts(other.id)[0]!;
    reviews.rate(otherVersion.versionId, 'GOOD');
    expect(reviews.searchGood('問い合わせ', 'WORK').map((item) => item.taskId)).toEqual([taskId]);
  });

  it('T-10-02 excludes unrated and Bad drafts from Good search', () => {
    const first = preparations.listArtifacts(taskId)[0]!;
    expect(reviews.searchGood('問い合わせ', 'WORK')).toEqual([]);
    reviews.rate(first.versionId, 'BAD');
    expect(reviews.searchGood('問い合わせ', 'WORK')).toEqual([]);
  });

  it('keeps feedback tied to its source version and never treats rating as approval', async () => {
    const first = preparations.listArtifacts(taskId)[0]!;
    const second = await preparations.revise(taskId, '比較表を追加してください', tasks, new MockAiAdapter());
    reviews.rate(second.versionId, 'GOOD');
    expect(preparations.feedbackHistory(taskId)[0]).toMatchObject({ sourceVersionId: first.versionId, appliedToVersionId: second.versionId });
    expect(reviews.approval(second.versionId)).toBe('UNAPPROVED');
  });
});
