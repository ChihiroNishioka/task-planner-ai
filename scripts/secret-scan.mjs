import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tokenPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9_./+-]{24,})/gi,
];
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const phonePattern = /(?:(\+\d{1,3})[ .-])?(\(?\d{3}\)?)[ .-](\d{3})[ .-](\d{4})\b/g;

export function scanText(text) {
  const findings = [];
  for (const pattern of tokenPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ kind: 'token' });
  }
  emailPattern.lastIndex = 0;
  for (const match of text.matchAll(emailPattern)) {
    if (match[1]?.toLowerCase() !== 'example.com') findings.push({ kind: 'email' });
  }
  phonePattern.lastIndex = 0;
  for (const match of text.matchAll(phonePattern)) {
    if (match[3] !== '555') findings.push({ kind: 'phone' });
  }
  return findings;
}

function trackedTextFiles() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
  }).split('\0').filter(Boolean);
  return paths.flatMap((path) => {
    const absolute = resolve(path);
    if (!existsSync(absolute)) return [];
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) return [];
    return [{ path, content: buffer.toString('utf8') }];
  });
}

function main() {
  let count = 0;
  for (const file of trackedTextFiles()) {
    const findings = scanText(file.content);
    for (const finding of findings) {
      process.stderr.write(`検出: ${file.path} (${finding.kind})\n`);
      count += 1;
    }
  }
  if (count) process.exitCode = 1;
  else process.stdout.write('秘密・メール・電話番号の走査に合格しました。\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
