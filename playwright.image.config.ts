import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import config from './playwright.config';

if (process.env.PW_PORT !== '3410') throw new Error('画像E2EはPW_PORT=3410で実行してください。');
if (resolve(process.env.E2E_DATA_DIR ?? '') !== '/workspace/dev/tp-image-data/e2e-image') throw new Error('画像E2Eの専用データディレクトリを指定してください。');
if (!process.env.SHOT_DIR || !resolve(process.env.SHOT_DIR).startsWith('/workspace/dev/tp-image-runs/')) throw new Error('SHOT_DIRはtp-image-runs配下に指定してください。');
if (!process.env.E2E_OUTPUT_DIR || !resolve(process.env.E2E_OUTPUT_DIR).startsWith('/workspace/dev/tp-image-runs/')) throw new Error('E2E_OUTPUT_DIRはtp-image-runs配下に指定してください。');
const server = config.webServer;
if (!server || Array.isArray(server)) throw new Error('単一のwebServer設定が必要です。');
export default defineConfig({ ...config, testMatch: ['image-proposal.spec.ts'], webServer: { ...server, env: { ...server.env, AI_MODE: 'mock', IMAGE_WORKER_GRACE_MS: '120000' } } });
