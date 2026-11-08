#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';

// テスト専用の偽CLI。実AI・外部通信は使用しない。
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.includes('<breakdown_items>')) process.exit(2);
const root = process.env.E2E_DATA_DIR;
const gate = process.env.FAKE_BREAKDOWN_GATE;
if (!root || !gate) process.exit(2);
const location = relative(resolve(root), resolve(gate));
if (!location || location.startsWith(`..${sep}`) || location === '..' || location.startsWith(sep)) process.exit(2);
writeFileSync(`${gate}/started`, '偽CLI開始');
const deadline = Date.now() + 20_000;
while (!existsSync(`${gate}/release`)) {
  if (Date.now() >= deadline) process.exit(3);
  await setTimeout(25);
}
process.stdout.write(JSON.stringify({ steps: ['偽CLIが生成した新版を確認する', '偽CLIの手順を検証する'] }));
