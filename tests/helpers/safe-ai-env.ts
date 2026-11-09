import { join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;
const AI_ENV_NAMES = ['AI_MODE', 'AI_CLI', 'AI_CLI_PATH', 'AI_CLI_MODEL', 'AI_TIMEOUT_MS'];

/** テストで実行してよいCLIは tests/fixtures の偽CLIと、存在しないことを確認する data/no-such-ai-cli だけ。 */
function allowedCliPaths(root: string): { fakes: string[]; missing: string } {
  return {
    fakes: [join(root, 'tests', 'fixtures', 'fake-breakdown-mids-cli.mjs'), join(root, 'tests', 'fixtures', 'fake-ai-cli.mjs'), join(root, 'tests', 'fixtures', 'fake-codex-cli.mjs'), join(root, 'tests', 'fixtures', 'fake-image-cli.mjs'), join(root, 'tests', 'fixtures', 'fake-image-gate-cli.mjs')],
    missing: join(root, 'data', 'no-such-ai-cli'),
  };
}

/** 親環境（= Webサーバーが継承する環境）が実CLIを呼び得るなら理由を返す。HTTP操作の前に呼んで失敗させる。 */
export function unsafeWebAiEnv(env: Env, root: string): string | null {
  if (env.AI_MODE !== 'cli') return null;
  const path = env.AI_CLI_PATH ? resolve(env.AI_CLI_PATH) : '';
  if (allowedCliPaths(root).fakes.includes(path)) return null;
  return '親環境で AI_MODE=cli かつ AI_CLI_PATH が偽CLIではありません。実CLIを呼ぶ恐れがあるためE2Eを中止します（AI_MODE と AI_CLI_PATH を外すか偽CLIを指定してください）。';
}

/** 子workerの環境。親のAI_*は継承せず既定はmock。cliを指定する場合は偽CLI/存在しないCLIだけ許可する。 */
export function buildWorkerEnv(parent: Env, extra: Record<string, string>, root: string): Env {
  const env: Env = { ...parent };
  for (const name of AI_ENV_NAMES) delete env[name];
  env.AI_MODE = 'mock';
  Object.assign(env, extra);
  if (env.AI_MODE === 'cli') {
    const path = env.AI_CLI_PATH ? resolve(env.AI_CLI_PATH) : '';
    const allowed = allowedCliPaths(root);
    if (!allowed.fakes.includes(path) && path !== allowed.missing) throw new Error('テストのworkerに実CLIは指定できません。偽CLIを指定してください。');
  }
  return env;
}
