import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const screenshots = join(process.cwd(), 'docs', 'screenshots');
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
      await expect(page.getByText('外部サービスはすべてモックです')).toBeVisible();
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-list.png`);
    });

    test('task detail', async ({ page, request }) => {
      const task = await createTask(request, `detail-${viewport.name}`);
      await page.goto(`/tasks/${task.id}`);
      await expect(page.getByRole('heading', { name: task.title })).toBeVisible();
      await expect(page.getByText('解析はモックのため行いません。')).toBeVisible();
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-detail.png`);
    });

    test('draft comparison', async ({ page, request }) => {
      const task = await createTask(request, `review-${viewport.name}`);
      const preparation = await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': `prepare-${viewport.name}` } });
      expect(preparation.status()).toBe(202);
      execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts', '--once'], {
        cwd: process.cwd(), timeout: 30_000, env: {
          ...process.env,
          DATABASE_PATH: join(process.cwd(), 'data', 'playwright.sqlite'),
          BLOB_DIRECTORY: join(process.cwd(), 'data', 'playwright-blobs'),
          ARTIFACT_DIRECTORY: join(process.cwd(), 'data', 'playwright-artifacts'),
        },
      });
      await request.post(`/api/tasks/${task.id}/feedback`, { data: { content: '結論を先に書いてください' } });
      await page.goto(`/tasks/${task.id}/review`);
      await expect(page.getByRole('heading', { name: '成果物レビュー' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'v1' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'v2' })).toBeVisible();
      await expectNoHorizontalOverflow(page, viewport.width);
      await capture(page, `${viewport.name}-draft-comparison.png`);
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
