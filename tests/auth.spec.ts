import { expect, test } from '@playwright/test';

test.describe('Google ログイン画面とセッション API', () => {
  test.beforeEach(async ({ context }) => { await context.clearCookies(); });

  test('未ログインのページはログインへ移動し、API は401を返す', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page).toHaveURL(/\/login\?next=/);
    const response = await page.request.get('/api/tasks');
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'ログインが必要です。' });
  });

  test('許可メールでログインし、ログアウト後は API が401になる', async ({ page, baseURL }) => {
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill('owner@example.com');
    await page.getByRole('button', { name: 'テストログイン' }).click();
    await page.waitForURL(`${baseURL}/`);
    await expect(page.getByText('ログイン中：owner@example.com')).toBeVisible();
    expect((await page.request.get('/api/tasks')).status()).toBe(200);
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get('/api/tasks')).status()).toBe(401);
  });

  test('許可外と未確認メールを日本語で拒否する', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill('other@example.com');
    await page.getByRole('button', { name: 'テストログイン' }).click();
    await expect(page.locator('[data-app-error="true"]')).toContainText('許可されたアカウント');
    const origin = new URL(page.url()).origin;
    const response = await page.request.post('/api/auth/session', { headers: { origin, 'content-type': 'application/json' }, data: { idToken: 'test:owner@example.com:unverified' } });
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'メールアドレスが確認されていないGoogleアカウントです。' });
  });

  test('ログイン中はボタンを無効にし、Origin 不一致を拒否する', async ({ page }) => {
    await page.goto('/login');
    await page.route('**/api/auth/session', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.getByLabel('メールアドレス').fill('owner@example.com');
    await page.getByRole('button', { name: 'テストログイン' }).click();
    const button = page.getByRole('button', { name: 'ログインしています…' });
    await expect(button).toBeDisabled();
    const response = await page.request.post('/api/auth/session', { headers: { origin: 'https://invalid.example', 'content-type': 'application/json' }, data: { idToken: 'test:owner@example.com:verified' } });
    expect(response.status()).toBe(403);
  });

  test('390px と 1280px の画面でレイアウトが横にはみ出さない', async ({ page }) => {
    await page.goto('/login');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.getByRole('button', { name: 'テストログイン' })).toBeVisible();
    }
  });
});
