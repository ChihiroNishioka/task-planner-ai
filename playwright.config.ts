import { resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const port = process.env.PW_PORT ?? '3100';
const sessionSecret = createHash('sha256').update('local-only-playwright-session').digest('base64url');
const sessionPayload = Buffer.from(JSON.stringify({ email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 60 * 60 })).toString('base64url');
const sessionValue = `${sessionPayload}.${createHmac('sha256', sessionSecret).update(sessionPayload).digest('base64url')}`;

const databasePath = resolve('data/playwright.sqlite');
process.env.DATABASE_PATH = databasePath;
process.env.BLOB_DIRECTORY = resolve('data/playwright-blobs');
process.env.ARTIFACT_DIRECTORY = resolve('data/playwright-artifacts');

export default defineConfig({
  testDir: './tests',
  testMatch: ['ui.spec.ts', 'auth.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    headless: true,
    storageState: { cookies: [{ name: 'task-planner-session', value: sessionValue, domain: '127.0.0.1', path: '/', expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] },
  },
  webServer: {
    command: `timeout 10s node scripts/prepare-playwright.mjs && exec timeout 10m npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_PATH: databasePath,
      BLOB_DIRECTORY: process.env.BLOB_DIRECTORY,
      ARTIFACT_DIRECTORY: process.env.ARTIFACT_DIRECTORY,
      AUTH_MODE: 'test',
      ALLOWED_EMAILS: 'owner@example.com',
      SESSION_SECRET: sessionSecret,
    },
  },
});
