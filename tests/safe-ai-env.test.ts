import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorkerEnv, unsafeWebAiEnv } from './helpers/safe-ai-env';

const root = '/tmp/tp-root';
const fake = join(root, 'tests', 'fixtures', 'fake-ai-cli.mjs');
const missing = join(root, 'data', 'no-such-ai-cli');

describe('E2E用の安全なAI環境', () => {
  it('S1 親のAI_MODEがmockまたは未設定ならWebは安全', () => {
    expect(unsafeWebAiEnv({}, root)).toBeNull();
    expect(unsafeWebAiEnv({ AI_MODE: 'mock' }, root)).toBeNull();
  });
  it('S2 AI_MODE=cli でAI_CLI_PATHが偽CLI以外（未設定含む）なら理由を返す', () => {
    expect(unsafeWebAiEnv({ AI_MODE: 'cli' }, root)).toMatch(/実CLI/);
    expect(unsafeWebAiEnv({ AI_MODE: 'cli', AI_CLI_PATH: '/usr/bin/claude' }, root)).toMatch(/実CLI/);
    expect(unsafeWebAiEnv({ AI_MODE: 'cli', AI_CLI: 'codex' }, root)).toMatch(/実CLI/);
    expect(unsafeWebAiEnv({ AI_MODE: 'cli', AI_CLI_PATH: fake }, root)).toBeNull();
  });
  it('S3 worker環境は親のAI_*を継承せず、既定はmock', () => {
    const env = buildWorkerEnv({ AI_MODE: 'cli', AI_CLI_PATH: '/usr/bin/claude', AI_CLI: 'codex', AI_CLI_MODEL: 'x', PATH: '/bin' }, {}, root);
    expect(env).toMatchObject({ AI_MODE: 'mock', PATH: '/bin' });
    expect(env.AI_CLI_PATH).toBeUndefined();
    expect(env.AI_CLI).toBeUndefined();
    expect(env.AI_CLI_MODEL).toBeUndefined();
  });
  it('S4 明示した偽CLIと存在しないCLIだけ許可し、実CLIは拒否する', () => {
    expect(buildWorkerEnv({}, { AI_MODE: 'cli', AI_CLI_PATH: fake }, root)).toMatchObject({ AI_MODE: 'cli', AI_CLI_PATH: fake });
    expect(buildWorkerEnv({}, { AI_MODE: 'cli', AI_CLI_PATH: missing }, root)).toMatchObject({ AI_CLI_PATH: missing });
    expect(() => buildWorkerEnv({}, { AI_MODE: 'cli', AI_CLI_PATH: '/usr/bin/claude' }, root)).toThrow();
    expect(() => buildWorkerEnv({}, { AI_MODE: 'cli' }, root)).toThrow();
  });
});
