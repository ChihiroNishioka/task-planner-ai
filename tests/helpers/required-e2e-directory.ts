import { mkdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export function requiredDirectory(name: 'E2E_DATA_DIR' | 'SHOT_DIR', root: string) {
  const allowedRoot = name === 'E2E_DATA_DIR' ? /^\/workspace\/dev\/tp-[a-z0-9-]+-data$/ : /^\/workspace\/dev\/tp-[a-z0-9-]+-runs$/;
  if (!allowedRoot.test(root) || root.startsWith('/workspace/dev/tp-live')) throw new Error(`${name}の許可ルートが不正です。`);
  const value = process.env[name];
  if (!value) throw new Error(`${name}を明示してください。`);
  const path = resolve(value);
  const child = relative(resolve(root), path);
  if (child === '..' || child.startsWith(`..${sep}`) || child.startsWith(sep)) throw new Error(`${name}は${root}内に限定してください。`);
  mkdirSync(path, { recursive: true });
  return path;
}
