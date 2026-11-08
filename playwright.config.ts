import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const databasePath = resolve('data/playwright.sqlite');
process.env.DATABASE_PATH = databasePath;
process.env.BLOB_DIRECTORY = resolve('data/playwright-blobs');
process.env.ARTIFACT_DIRECTORY = resolve('data/playwright-artifacts');

export default defineConfig({
  testDir: './tests',
  testMatch: 'ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'timeout 10s node scripts/prepare-playwright.mjs && exec timeout 10m npm run dev -- --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_PATH: databasePath,
      BLOB_DIRECTORY: process.env.BLOB_DIRECTORY,
      ARTIFACT_DIRECTORY: process.env.ARTIFACT_DIRECTORY,
    },
  },
});
