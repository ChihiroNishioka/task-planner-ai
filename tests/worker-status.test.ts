import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_STALE_MS, WorkerStatusStore, describeWorker } from '../src/adapters/worker-status';

describe('ワーカーの実行モード記録', () => {
  let directory: string;
  let store: WorkerStatusStore;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'tp-worker-status-')); store = new WorkerStatusStore(join(directory, 'db.sqlite')); });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  const now = new Date('2026-11-08T03:00:00.000Z');

  it('一度も起動していなければ「未起動」で、モードを断定しない', () => {
    const view = describeWorker(store.read(), now);
    expect(view).toMatchObject({ state: 'never', mode: null });
    expect(view.label).toContain('未起動');
  });

  it('新しいheartbeatならワーカーの実モードを返す（Web側の環境変数は見ない）', () => {
    store.beat('cli', 1234, new Date(now.getTime() - 3_000));
    expect(describeWorker(store.read(), now)).toMatchObject({ state: 'running', mode: 'cli' });
    store.beat('mock', 1234, new Date(now.getTime() - 3_000));
    expect(describeWorker(store.read(), now)).toMatchObject({ state: 'running', mode: 'mock' });
  });

  it('古いheartbeatは「応答なし」で、最後のモードを参考として示すだけにする', () => {
    store.beat('cli', 1234, new Date(now.getTime() - WORKER_STALE_MS - 1_000));
    const view = describeWorker(store.read(), now);
    expect(view.state).toBe('stale');
    expect(view.mode).toBeNull();
    expect(view.lastMode).toBe('cli');
    expect(view.label).toMatch(/停止|応答/);
  });

  it('正常終了を記録すると「停止中」になる', () => {
    store.beat('cli', 1234, now);
    store.markStopped(1234, now);
    expect(describeWorker(store.read(), now)).toMatchObject({ state: 'stopped', mode: null, lastMode: 'cli' });
  });

  it('別プロセスの停止記録で動作中のワーカーを止まったことにしない', () => {
    store.beat('cli', 1234, now);
    store.markStopped(9999, now);
    expect(describeWorker(store.read(), now).state).toBe('running');
  });
});
