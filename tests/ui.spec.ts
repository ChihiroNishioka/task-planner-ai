import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { buildWorkerEnv, unsafeWebAiEnv } from './helpers/safe-ai-env';

const screenshots = process.env.SHOT_DIR ?? join(process.cwd(), 'docs', 'screenshots');
const webAi = process.env.E2E_WEB_AI === '1';
// HTTP操作や子worker起動の前に、親環境が実CLIを呼び得るならここで失敗させる（Webサーバーは親環境を継承するため）。
const unsafeReason = unsafeWebAiEnv(process.env, process.cwd());
if (unsafeReason) throw new Error(unsafeReason);
const fakeCli = join(process.cwd(), 'tests', 'fixtures', 'fake-ai-cli.mjs');
mkdirSync(screenshots, { recursive: true });
const viewports = [
  { name: 'iphone-390x844', width: 390, height: 844 },
  { name: 'pc-1280x800', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`${viewport.name} screenshots`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: viewport.width, height: viewport.height }); });

    test('task list', async ({ page, request }) => {
      const task = await createTask(request, `list-${viewport.name}`);
      await page.goto('/');
      await expect(page.getByRole('link', { name: task.title })).toBeVisible();
      await expect(page.locator('.mock-banner')).toContainText('モック');
      const card = page.locator('.task-card', { hasText: task.title });
      await expect(card.locator('.badges')).toContainText('未着手');
      await expect(card.locator('.badges')).toContainText('AI 準備なし');
      await expect(page.locator('main')).not.toContainText(/\b(OPEN|NOT_REQUIRED|READY|IN_PROGRESS|WAITING_CONFIRMATION)\b/);
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-list.png`);
    });

    test('task detail', async ({ page, request }) => {
      const task = await createTask(request, `detail-${viewport.name}`);
      await page.goto(`/tasks/${task.id}`);
      await expect(page.getByRole('heading', { name: task.title })).toBeVisible();
      await expect(page.getByText('通常の添付は解析未実行です。')).toBeVisible();
      await expect(page.locator('.detail-card')).toContainText('未着手 / AI 準備なし');
      await expect(page.locator('.detail-card')).toContainText('仕事 / 一般');
      await expect(page.locator('main')).not.toContainText(/\b(OPEN|NOT_REQUIRED|GENERAL|WORK)\b/);
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-detail.png`);
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
      await expect(page.locator('.service-list')).toContainText('AI');
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-settings.png`);
    });

    test('draft comparison', async ({ page, request }) => {
      const task = await createTask(request, `review-${viewport.name}`);
      const preparation = await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': `prepare-${viewport.name}` } });
      expect(preparation.status()).toBe(202);
      runWorker({});
      await createDraftAfterPreparation(request, task.id, {});
      await request.post(`/api/tasks/${task.id}/feedback`, { data: { content: '結論を先に書いてください' } });
      await page.goto(`/tasks/${task.id}/review`);
      await expect(page.getByRole('heading', { name: '成果物レビュー' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'v1' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'v2' })).toBeVisible();
      await expect(page.locator('.detail-card')).toContainText('評価 未評価・最終版 未承認');
      await expect(page.locator('main')).not.toContainText(/\b(UNRATED|UNAPPROVED|MOCK_SAVED)\b/);
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-draft-comparison.png`);
    });

    test('AI generation: loading then AI result', async ({ page, request }) => {
      const task = await createTask(request, `ai-${viewport.name}`);
      const preparation = await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': `ai-${viewport.name}` } });
      expect(preparation.status()).toBe(202);
      await page.goto(`/tasks/${task.id}`);
      await expect(page.locator('.ai-loading')).toContainText('AIが分解を作成中');
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-ai-loading.png`);
      runWorker({ AI_MODE: 'cli', AI_CLI: 'claude', AI_CLI_PATH: join(process.cwd(), 'tests', 'fixtures', 'fake-ai-cli.mjs'), AI_TIMEOUT_MS: '10000' });
      await expect(page.getByRole('region', { name: 'AIの準備結果' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: '分解編集' }).locator('.ai-steps li')).toHaveCount(4);
      await createDraftAfterPreparation(request, task.id, { AI_MODE: 'cli', AI_CLI: 'claude', AI_CLI_PATH: fakeCli, AI_TIMEOUT_MS: '10000' });
      await page.reload();
      const result = page.getByRole('region', { name: 'AIの準備結果' });
      await expect(result.locator('.mode-badge')).toHaveText('AI生成', { timeout: 15_000 });
      await expect(page.getByRole('region', { name: '分解編集' }).locator('.ai-steps li')).toHaveCount(4);
      await expect(result.locator('.ai-draft')).toContainText('構成案');
      await expectNoHorizontalOverflow(page, viewport.width);
      await result.scrollIntoViewIfNeeded();
      await capture(page, `${viewport.name}-ai-success.png`);
    });

    test('AI failure falls back to the labeled mock', async ({ page, request }) => {
      const task = await createTask(request, `fallback-${viewport.name}`);
      const preparation = await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': `fallback-${viewport.name}` } });
      expect(preparation.status()).toBe(202);
      runWorker({ AI_MODE: 'cli', AI_CLI_PATH: join(process.cwd(), 'data', 'no-such-ai-cli'), AI_TIMEOUT_MS: '5000' });
      await createDraftAfterPreparation(request, task.id, { AI_MODE: 'cli', AI_CLI_PATH: join(process.cwd(), 'data', 'no-such-ai-cli'), AI_TIMEOUT_MS: '5000' });
      const artifacts = await request.get(`/api/tasks/${task.id}/artifacts`);
      const body = await artifacts.json() as { artifacts: Array<{ mode: string; fallbackReason: string | null; modeLabel: string }> };
      expect(body.artifacts.at(-1)).toMatchObject({ mode: 'mock_fallback', fallbackReason: 'CLI_NOT_FOUND' });
      await page.goto(`/tasks/${task.id}`);
      const result = page.getByRole('region', { name: 'AIの準備結果' });
      await expect(result.locator('.mode-badge')).toContainText('モック（AI失敗');
      await expect(result.locator('.fallback-note')).toContainText('CLI_NOT_FOUND');
      await expect(result.locator('.ai-draft')).toContainText('モック生成');
      await expectNoHorizontalOverflow(page, viewport.width);
      await result.scrollIntoViewIfNeeded();
      await capture(page, `${viewport.name}-ai-fallback.png`);
    });

    test('AI generation with empty task text', async ({ page, request }) => {
      const response = await request.post('/api/tasks', { headers: { 'idempotency-key': `empty-${viewport.name}` }, data: { title: `本文なしタスク ${viewport.name}`, category: 'WORK' } });
      expect(response.status()).toBe(201);
      const { task } = await response.json() as { task: { id: string } };
      await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': `empty-${viewport.name}` } });
      runWorker({ AI_MODE: 'cli', AI_CLI_PATH: join(process.cwd(), 'tests', 'fixtures', 'fake-ai-cli.mjs'), AI_TIMEOUT_MS: '10000' });
      await createDraftAfterPreparation(request, task.id, { AI_MODE: 'cli', AI_CLI_PATH: fakeCli, AI_TIMEOUT_MS: '10000' });
      await page.goto(`/tasks/${task.id}`);
      await expect(page.getByRole('region', { name: 'AIの準備結果' }).locator('.mode-badge')).toHaveText('AI生成');
    });

    test('worker mode shown by the UI is the worker mode, not the web env', async ({ page }) => {
      const status = async (expected: string, bannerText: string, state: string) => {
        await expect.poll(async () => {
          const ai = (await (await page.request.get('/api/services')).json() as { services: Array<{ name: string; label: string; worker?: { state: string } }> }).services.find((service) => service.name === 'AI');
          return ai?.worker?.state === state ? ai.label : '';
        }, { timeout: 20_000 }).toContain(expected);
        await page.goto('/');
        await expect(page.locator('.mock-banner')).toContainText(bannerText);
        await expectNoHorizontalOverflow(page, viewport.width);
      };
      const mockWorker = startWorker({ AI_MODE: 'mock' });
      try {
        await status('モック', 'モックです', 'running');
        await page.goto('/settings');
        await expect(page.locator('.service-list li').filter({ has: page.getByText('AI', { exact: true }) })).toContainText('モック');
        await expect(page.locator('.service-list li').filter({ has: page.getByText('AI', { exact: true }) })).not.toContainText('サブスクCLI');
      } finally { await stopWorker(mockWorker); }
      const cliWorker = startWorker({ AI_MODE: 'cli', AI_CLI_PATH: fakeCli });
      try {
        await status('サブスクCLI', 'AIはサブスクCLIで生成します', 'running');
        await page.goto('/settings');
        await expect(page.locator('.service-list li').filter({ has: page.getByText('AI', { exact: true }) })).toContainText('サブスクCLI');
        await capture(page, `${viewport.name}-settings-worker-cli.png`);
      } finally { await stopWorker(cliWorker); }
      await status('停止中', '停止', 'stopped');
    });

    test('revision from feedback uses the AI and shows the AI label', async ({ page, request }) => {
      test.skip(!webAi, 'Web側にAI_MODE=cli（偽CLI）を設定した実行でのみ検証する');
      const task = await createTask(request, `revise-ai-${viewport.name}`);
      await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': `revise-ai-${viewport.name}` } });
      runWorker({ AI_MODE: 'cli', AI_CLI_PATH: fakeCli, AI_TIMEOUT_MS: '10000' });
      await createDraftAfterPreparation(request, task.id, { AI_MODE: 'cli', AI_CLI_PATH: fakeCli, AI_TIMEOUT_MS: '10000' });
      await page.goto(`/tasks/${task.id}/review`);
      await expect(page.getByRole('heading', { name: 'v1' })).toBeVisible();
      await expect(page.locator('.revision-notice')).toContainText('初版はワーカーの設定');
      await expect(page.locator('.revision-notice')).toContainText('修正版はWeb側の設定でAI');
      await page.getByLabel('修正指示').fill('結論を先に書いてください');
      const feedbackResponse = page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${task.id}/feedback`) && response.request().method() === 'POST');
      await page.getByRole('button', { name: '修正版を作る' }).click();
      await expect(page.getByRole('button', { name: /改訂版を作成中/ })).toBeVisible();
      const feedbackBody = await (await feedbackResponse).json() as { label: string; artifact: { modeLabel: string } };
      expect(feedbackBody.label).toBe(feedbackBody.artifact.modeLabel);
      expect(feedbackBody.label).toBe('AI生成');
      await expect(page.getByRole('heading', { name: 'v2' })).toBeVisible({ timeout: 20_000 });
      const v2 = page.locator('.version-card', { has: page.getByRole('heading', { name: 'v2' }) });
      await expect(v2.locator('.mode-badge')).toHaveText('AI生成');
      await expect(v2).toContainText('偽CLIの改訂版');
      await expect(page.getByRole('status').filter({ hasText: 'AI生成' })).toBeVisible();
      await expectNoHorizontalOverflow(page, viewport.width);
      await v2.scrollIntoViewIfNeeded();
      await capture(page, `${viewport.name}-revise-ai.png`);
    });

    test('revision falls back to the mock and shows the reason', async ({ page, request }) => {
      test.skip(!webAi, 'Web側にAI_MODE=cli（偽CLI）を設定した実行でのみ検証する');
      const task = await createTask(request, `revise-fb-${viewport.name}`);
      await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': `revise-fb-${viewport.name}` } });
      runWorker({ AI_MODE: 'cli', AI_CLI_PATH: fakeCli, AI_TIMEOUT_MS: '10000' });
      await createDraftAfterPreparation(request, task.id, { AI_MODE: 'cli', AI_CLI_PATH: fakeCli, AI_TIMEOUT_MS: '10000' });
      await page.goto(`/tasks/${task.id}/review`);
      await page.getByLabel('修正指示').fill('FAKE_CLI_EXIT_1 失敗させる');
      await page.getByRole('button', { name: '修正版を作る' }).click();
      const v2 = page.locator('.version-card', { has: page.getByRole('heading', { name: 'v2' }) });
      await expect(v2.locator('.mode-badge')).toContainText('モック（AI失敗: AIのCLIがエラーで終了しました）', { timeout: 20_000 });
      await expect(v2).toContainText('モック改訂');
      await expectNoHorizontalOverflow(page, viewport.width);
      await v2.scrollIntoViewIfNeeded();
      await capture(page, `${viewport.name}-revise-fallback.png`);
      await page.goto(`/tasks/${task.id}`);
      await expect(page.locator('.fallback-note')).toContainText('修正指示をもう一度送');
      await expect(page.locator('.fallback-note')).not.toContainText('「この分解でドラフトを作る」を押して');
    });

    test('services API failure shows a Japanese error with retry on the list', async ({ page }) => {
      let fail = true;
      await page.route('**/api/services', (route) => fail
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) })
        : route.continue());
      await page.goto('/');
      await expect(page.locator('.mock-banner')).toContainText('サービスの状態を取得できませんでした');
      await expect(page.locator('.mock-banner')).not.toContainText('確認中');
      fail = false;
      await page.getByRole('button', { name: '状態を再取得' }).click();
      await expect(page.locator('.mock-banner')).not.toContainText('サービスの状態を取得できませんでした');
    });

    test('open list and settings pages follow the worker heartbeat by polling', async ({ page }) => {
      const worker = startWorker({ AI_MODE: 'cli', AI_CLI_PATH: fakeCli });
      try {
        await page.goto('/');
        await expect(page.locator('.mock-banner')).toContainText('AIはサブスクCLIで生成します', { timeout: 20_000 });
      } finally { await stopWorker(worker); }
      await expect(page.locator('.mock-banner')).toContainText('停止', { timeout: 20_000 });
      await expect(page.locator('.mock-banner')).not.toContainText('AIはサブスクCLIで生成します');
    });

    test('loading state', async ({ page }) => {
      await page.route('**/api/tasks', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) });
      });
      await page.goto('/');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中' })).toBeVisible();
      await capture(page, `${viewport.name}-loading.png`);
    });

    test('error state', async ({ page }) => {
      await page.route('**/api/tasks', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) }));
      await page.goto('/');
      await expect(page.locator('.state.error')).toContainText('タスクを読み込めませんでした');
      await expect(page.getByRole('button', { name: '再試行' })).toBeVisible();
      await capture(page, `${viewport.name}-error.png`);
    });

    test('empty state', async ({ page }) => {
      await page.route('**/api/tasks', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }));
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'タスクはありません' })).toBeVisible();
      await capture(page, `${viewport.name}-empty.png`);
    });
  });
}

function workerEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env = buildWorkerEnv(process.env, extraEnv, process.cwd());
  env.DATABASE_PATH = process.env.DATABASE_PATH ?? join(process.cwd(), 'data', 'playwright.sqlite');
  env.BLOB_DIRECTORY = process.env.BLOB_DIRECTORY ?? join(process.cwd(), 'data', 'playwright-blobs');
  env.ARTIFACT_DIRECTORY = process.env.ARTIFACT_DIRECTORY ?? join(process.cwd(), 'data', 'playwright-artifacts');
  return env as NodeJS.ProcessEnv;
}

async function createDraftAfterPreparation(request: APIRequestContext, taskId: string, extraEnv: Record<string, string>) {
  const artifacts = await (await request.get(`/api/tasks/${taskId}/artifacts`)).json() as { artifacts: unknown[] };
  expect(artifacts.artifacts).toHaveLength(0);
  const flow = await (await request.get(`/api/tasks/${taskId}/draft`)).json() as { breakdown: { latestVersionId: string | null; stepCount: number } };
  expect(flow.breakdown.stepCount).toBeGreaterThan(0);
  expect((await request.post(`/api/tasks/${taskId}/draft`, { data: { action: 'create', breakdownVersionId: flow.breakdown.latestVersionId, requestKey: `draft-${taskId}` } })).status()).toBe(202);
  runWorker(extraEnv);
}

function runWorker(extraEnv: Record<string, string>) {
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts', '--once'], { cwd: process.cwd(), timeout: 30_000, env: workerEnv(extraEnv) });
}

/** 常駐ワーカーを起動する。このテストが起動したPIDだけを停止する。 */
function startWorker(extraEnv: Record<string, string>) {
  return spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts'], { cwd: process.cwd(), env: workerEnv(extraEnv), stdio: 'ignore' });
}

async function stopWorker(child: ReturnType<typeof startWorker>) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
  await exited;
  clearTimeout(timer);
}

async function createTask(request: APIRequestContext, key: string) {
  const response = await request.post('/api/tasks', {
    headers: { 'idempotency-key': key },
    data: { title: `合成タスク ${key}`, originalInput: 'スクリーンショット用の合成タスク', category: 'WORK' },
  });
  expect(response.status()).toBe(201);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('task' in body)) throw new Error('タスクAPIの応答が不正です。');
  const task = body.task;
  if (typeof task !== 'object' || task === null || !('id' in task) || !('title' in task) || typeof task.id !== 'string' || typeof task.title !== 'string') {
    throw new Error('タスクAPIの応答が不正です。');
  }
  return { id: task.id, title: task.title };
}

async function expectNoHorizontalOverflow(page: Page, viewportWidth: number) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(viewportWidth);
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(screenshots, name), animations: 'disabled' });
}
