import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { requiredDirectory } from './helpers/required-e2e-directory';

vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([
  ['E2E_DATA_DIR', '/'], ['SHOT_DIR', '/'],
  ['E2E_DATA_DIR', '/workspace/dev/tp-live-data'],
  ['SHOT_DIR', '/workspace/dev/tp-live-review-runs'],
  ['E2E_DATA_DIR', '/workspace/dev/tp-left-runs'],
  ['SHOT_DIR', '/workspace/dev/tp-left-data'],
  ['E2E_DATA_DIR', '/workspace/dev/tp-LEFT-data'],
  ['SHOT_DIR', '/workspace/dev/tp-left-runs/..'],
] as const)('許可境界 %s は不正なルート %s をmkdir前に拒否する', (name, root) => {
  vi.stubEnv(name, root === '/' ? '/tmp/synthetic-e2e' : `${root}/case`);
  expect(() => requiredDirectory(name, root)).toThrow();
  expect(mkdirSync).not.toHaveBeenCalled();
});

it.each([
  ['E2E_DATA_DIR', '/workspace/dev/tp-left-data'],
  ['SHOT_DIR', '/workspace/dev/tp-left-runs'],
  ['E2E_DATA_DIR', '/workspace/dev/tp-mid-data'],
  ['SHOT_DIR', '/workspace/dev/tp-mid-runs'],
] as const)('許可境界 %s は隔離ルートとその子を受け付ける', (name, root) => {
  for (const path of [root, `${root}/case`]) {
    vi.stubEnv(name, path);
    expect(requiredDirectory(name, root)).toBe(path);
    expect(mkdirSync).toHaveBeenLastCalledWith(path, { recursive: true });
  }
});

it('許可境界は未指定の保存先とルート外への脱出を拒否する', () => {
  vi.stubEnv('E2E_DATA_DIR', '');
  expect(() => requiredDirectory('E2E_DATA_DIR', '/workspace/dev/tp-mid-data')).toThrow();
  vi.stubEnv('E2E_DATA_DIR', '/workspace/dev/tp-mid-data/../tp-other-data');
  expect(() => requiredDirectory('E2E_DATA_DIR', '/workspace/dev/tp-mid-data')).toThrow();
  expect(mkdirSync).not.toHaveBeenCalled();
});
