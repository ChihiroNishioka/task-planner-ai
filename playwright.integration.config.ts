import { relative, resolve, sep } from 'node:path';
import { defineConfig } from '@playwright/test';
import references from './playwright.references.config';

function within(value: string | undefined, root: string): boolean {
  if (!value) return false;
  const path = relative(root, resolve(value));
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

if (process.env.PW_PORT !== '3350'
  || !within(process.env.E2E_DATA_DIR, '/workspace/dev/tp-ref-data')
  || !within(process.env.E2E_OUTPUT_DIR, '/workspace/dev/tp-ref-runs')
  || !within(process.env.SHOT_DIR, '/workspace/dev/tp-ref-runs')) {
  throw new Error('統合検証はPW_PORT=3350と専用のDB・成果ログ・スクリーンショットディレクトリを指定してください。');
}

export default defineConfig({
  ...references,
  testMatch: ['ui.spec.ts', 'auth.spec.ts', 'breakdown.spec.ts', 'references.spec.ts', 'reference-breakdown.spec.ts'],
});
