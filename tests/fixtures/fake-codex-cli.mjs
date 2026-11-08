#!/usr/bin/env node
// テスト専用の偽codex。実AIは呼ばない。FAKE_CODEX_RECORD に args/stdin を記録し、FAKE_CODEX_MODE で挙動を変える。
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const record = process.env.FAKE_CODEX_RECORD;
  if (record) writeFileSync(record, JSON.stringify({ args, input, cwd: process.cwd() }));
  const outIndex = args.indexOf('-o');
  const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
  const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
  const valid = JSON.stringify({ steps: ['目的を書く', '資料を集める', '構成を作る'], draftMarkdown: '# 偽codex\n\n## 目的\n\n要確認\n' });
  if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    if (process.env.FAKE_CODEX_CHILD_PID) appendFileSync(process.env.FAKE_CODEX_CHILD_PID, String(child.pid));
    setTimeout(() => {}, 60000);
    return;
  }
  if (mode === 'big') writeFileSync(outFile, 'x'.repeat(300_000));
  else if (mode === 'garbage') writeFileSync(outFile, 'JSONではない出力');
  else if (mode === 'nofile') { /* 出力ファイルを作らない */ }
  else writeFileSync(outFile, valid);
  process.stdout.write('codex stdout noise');
});
