import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const path of ['README.md', 'ARCHITECTURE.md', 'DATA_MODEL.md', '.env.example', 'Dockerfile', 'compose.yml']) {
  test(`Phase 0 artifact exists: ${path}`, async () => {
    const content = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.ok(content.trim().length > 0);
  });
}

test('environment template keeps credential values empty', async () => {
  const env = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    if (/(_KEY|_TOKEN|_SECRET|PASSWORD)=/.test(line)) assert.match(line, /=$/);
  }
});
