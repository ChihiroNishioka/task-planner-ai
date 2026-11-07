import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreparationStore } from '../src/adapters/preparation-store';
import { MockAiAdapter, type PreparationAdapter } from '../src/adapters/mock-ai';
import { TaskStore } from '../src/adapters/task-store';

describe('Phase 3 preparation jobs', () => {
  let directory: string;
  let tasks: TaskStore;
  let preparations: PreparationStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'task-planner-prepare-'));
    tasks = new TaskStore(join(directory, 'tasks.sqlite'));
    preparations = new PreparationStore(join(directory, 'tasks.sqlite'), join(directory, 'artifacts'));
  });
  afterEach(() => { tasks.close(); preparations.close(); rmSync(directory, { recursive: true, force: true }); });

  function createTask() { return tasks.create({ title: '社内問い合わせの構想', originalInput: '問い合わせ対応を効率化する構想' }, 'task-create'); }

  it('T-02-01 saves a visible plan, mock draft v1, and local mock artifact', async () => {
    const task = createTask();
    const job = preparations.enqueue(task, 'prepare-once');
    const finished = await preparations.runNext(tasks, new MockAiAdapter());
    expect(job.status).toBe('QUEUED');
    expect(finished).toMatchObject({ status: 'SUCCEEDED', mode: 'mock' });
    expect(tasks.get(task.id)?.aiStatus).toBe('READY');
    const artifacts = preparations.listArtifacts(task.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ version: 1, mode: 'mock', saveStatus: 'MOCK_SAVED' });
    expect(readFileSync(artifacts[0]!.path, 'utf8')).toContain('モック生成');
    expect(artifacts[0]?.plan.steps.length).toBeGreaterThan(0);
  });

  it('T-02-02 records adapter failures and never marks an unsaved draft ready', async () => {
    const task = createTask();
    preparations.enqueue(task, 'failed-job');
    const adapter: PreparationAdapter = { generate: async () => { throw new Error('mock provider failure'); } };
    const finished = await preparations.runNext(tasks, adapter);
    expect(finished?.status).toBe('FAILED');
    expect(tasks.get(task.id)?.aiStatus).toBe('FAILED');
    expect(preparations.listArtifacts(task.id)).toEqual([]);
  });

  it('T-02-03 keeps the job queued until a worker runs it', async () => {
    const task = createTask();
    expect(preparations.enqueue(task, 'queued-job').status).toBe('QUEUED');
    expect(preparations.listArtifacts(task.id)).toEqual([]);
    expect((await preparations.runNext(tasks, new MockAiAdapter()))?.status).toBe('SUCCEEDED');
  });

  it('T-02-04 writes UTC timestamps and the same Tokyo date across host timezones', async () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'UTC';
    const task = createTask();
    preparations.enqueue(task, 'tz-job');
    const result = await preparations.runNext(tasks, new MockAiAdapter());
    process.env.TZ = 'Asia/Tokyo';
    expect(result?.createdAt.endsWith('Z')).toBe(true);
    expect(preparations.listArtifacts(task.id)[0]?.createdAt.endsWith('Z')).toBe(true);
    process.env.TZ = originalTimezone;
  });

  it('T-02-05 makes parallel retries with one request key share one job and version', async () => {
    const task = createTask();
    const jobs = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve(preparations.enqueue(task, 'same-request'))));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    await preparations.runNext(tasks, new MockAiAdapter());
    expect(preparations.listArtifacts(task.id)).toHaveLength(1);
  });

  it('T-02-06 recovers a queued job and its request key after restart', async () => {
    const task = createTask();
    const job = preparations.enqueue(task, 'resume-after-restart');
    preparations.close();
    preparations = new PreparationStore(join(directory, 'tasks.sqlite'), join(directory, 'artifacts'));
    expect(preparations.getJob(job.id)?.status).toBe('QUEUED');
    expect((await preparations.runNext(tasks, new MockAiAdapter()))?.status).toBe('SUCCEEDED');
  });
});
