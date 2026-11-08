import { defineConfig } from '@playwright/test';
import base from './playwright.config';

if (process.env.PW_PORT !== '3350') throw new Error('関連資料検証はPW_PORT=3350を指定してください。');
if (!process.env.E2E_DATA_DIR?.startsWith('/workspace/dev/tp-ref-data/')) throw new Error('関連資料検証はtp-ref-data配下を指定してください。');
const appServer = base.webServer;
if (!appServer || Array.isArray(appServer)) throw new Error('アプリ検証サーバーの設定を確認してください。');
export default defineConfig({
  ...base,
  testMatch: ['references.spec.ts', 'auth.spec.ts'],
  webServer: [
    {
      command: 'timeout --foreground 10m node tests/fixtures/reference-site.mjs',
      url: 'http://127.0.0.1:3351/health', reuseExistingServer: false, timeout: 15_000,
    },
    {
      ...appServer,
      env: { ...appServer.env, REFERENCE_FETCH_MODE: 'fixture' },
    },
  ],
});
