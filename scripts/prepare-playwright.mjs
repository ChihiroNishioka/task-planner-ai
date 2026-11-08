import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDirectory = resolve('data');
for (const path of ['playwright.sqlite', 'playwright.sqlite-shm', 'playwright.sqlite-wal', 'playwright-blobs', 'playwright-artifacts']) {
  rmSync(resolve(dataDirectory, path), { recursive: true, force: true });
}
mkdirSync(dataDirectory, { recursive: true });
