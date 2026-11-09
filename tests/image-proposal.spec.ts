import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { requiredDirectory } from './helpers/required-e2e-directory';
import { buildWorkerEnv } from './helpers/safe-ai-env';
import { syntheticPng } from './helpers/synthetic-images';

const data = requiredDirectory('E2E_DATA_DIR', '/workspace/dev/tp-image-data');
const shots = requiredDirectory('SHOT_DIR', '/workspace/dev/tp-image-runs');
const sizes = [{ name: 'iphone-390x844', width: 390, height: 844 }, { name: 'pc-1280x800', width: 1280, height: 800 }];
const png = syntheticPng({ width: 240, height: 160 });
const file = { name: 'synthetic-2030-12-01.png', mimeType: 'image/png', buffer: png };
function worker(extra: Record<string, string> = {}) {
  const env = buildWorkerEnv(process.env, extra, process.cwd());
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts', '--once'], { timeout: 30_000, env: { ...env, NODE_ENV: 'test', DATABASE_PATH: join(data, 'playwright.sqlite'), BLOB_DIRECTORY: join(data, 'playwright-blobs'), ARTIFACT_DIRECTORY: join(data, 'playwright-artifacts') }, stdio: 'pipe' });
}
async function choose(page: Page) { await page.locator('#image-task-file').setInputFiles(file); }
async function read(page: Page) { await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/image-proposals') && response.request().method() === 'POST'), page.getByRole('button', { name: '画像を読み取る', exact: true }).click()]); }
async function start(page: Page) { await choose(page); await read(page); }
async function ready(page: Page) { await start(page); worker(); await expect(page.getByRole('heading', { name: '内容を確認' })).toBeVisible(); }
async function shot(page: Page, name: string, size: typeof sizes[number]) {
  const preview = page.locator('.preview img, img[alt^="添付画像:"]').first();
  if (await preview.count()) await preview.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const button of await page.locator('[aria-label="画像から作る"] button').all()) {
    if (!(await button.isVisible())) continue;
    const height = await button.evaluate(node => (node as HTMLElement).offsetHeight);
    if (height === 0) continue; // Astryx の見えない補助ボタンは対象外
    expect(height).toBeGreaterThanOrEqual(44);
  }
  if (name.endsWith('created')) {
    const thumbnail = page.getByRole('img', { name: /^添付画像:/ });
    await expect(thumbnail).toBeVisible();
    await thumbnail.scrollIntoViewIfNeeded();
    await expect.poll(() => thumbnail.evaluate(node => node instanceof HTMLImageElement ? node.naturalWidth : 0)).toBeGreaterThan(0);
  }
  await page.screenshot({ path: join(shots, `${size.name}-${name}.png`), animations: 'disabled' });
}
for (const size of sizes) test.describe(size.name, () => {
  test.use({ viewport: size });
  test.beforeEach(async ({ page, request }) => {
    await page.goto('/');
    // 初回はページ表示だけでは SQLite が未だ無い（prepare が消したあと、最初の API で作られる）。
    const databasePath = join(data, 'playwright.sqlite');
    if (!existsSync(databasePath)) return;
    let proposalIds: string[] = [];
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'image_proposals'").get();
      if (table) {
        proposalIds = z.array(z.string()).parse(db.prepare("SELECT id FROM image_proposals WHERE status IN ('QUEUED','RUNNING','READY')").pluck().all());
      }
    } finally {
      db.close();
    }
    for (const id of proposalIds) {
      const response = await request.delete(`/api/image-proposals/${id}`, { headers: { origin: new URL(page.url()).origin } });
      expect(response.status()).toBe(204);
    }
  });
  test('E-01 E-02 E-03 E-04 E-16 選択、読み取り、モック確認、編集して作成', async ({ page }) => {
    await expect(page.getByRole('heading', { name: '画像から作る' })).toBeVisible(); await shot(page, 'empty', size);
    await choose(page); await expect(page.getByText(file.name, { exact: true })).toBeVisible(); await shot(page, 'selected', size);
    await read(page);
    await expect(page.getByTestId('image-proposal-status')).toContainText('画像を読み取っています…');
    await expect(page.getByRole('button', { name: 'タスクを追加', exact: true })).toBeDisabled(); await shot(page, 'reading', size);
    worker(); await expect(page.getByRole('heading', { name: '内容を確認' })).toBeVisible(); await expect(page.getByRole('heading', { name: '内容を確認' })).toBeFocused();
    await expect(page.getByTestId('image-proposal-mode')).toHaveText('内容はモック。');
    const preview = page.getByRole('img', { name: /^選択した画像:/ });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate(node => node instanceof HTMLImageElement ? node.naturalWidth : 0)).toBeGreaterThan(0);
    await expect(page.getByLabel('読み取った文章', { exact: true })).toHaveCount(0);
    await page.getByLabel('タイトル', { exact: true }).fill('合成画像から作ったタスク');
    await page.getByLabel('提案の期限').fill('2030-12-24');
    await preview.scrollIntoViewIfNeeded(); await shot(page, 'confirmation', size);
    await page.getByRole('button', { name: 'この内容でタスクを作成' }).click(); await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
    await expect(page.getByRole('heading', { name: '合成画像から作ったタスク', exact: true })).toBeVisible();
    await expect(page.locator('.detail-card')).toContainText('2030-12-24');
    const image = page.getByRole('img', { name: /^添付画像:/ }); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0); await shot(page, 'created', size);
  });
  test('E-05 偽CLIの読み取り結果を表示', async ({ page }) => {
    await start(page); worker({ AI_MODE: 'cli', AI_CLI: 'claude', AI_CLI_PATH: join(process.cwd(), 'tests/fixtures/fake-image-cli.mjs') });
    await expect(page.getByLabel('読み取った文章', { exact: true })).toBeVisible(); await expect(page.getByTestId('image-proposal-mode')).toContainText('AI生成'); await shot(page, 'ai', size);
  });
  test('E-06 偽CLIの失敗をモックと理由で示して作成', async ({ page }) => {
    await page.getByLabel('新しいタスク', { exact: true }).fill('FAKE_CLI_EXIT_1'); await start(page);
    worker({ AI_MODE: 'cli', AI_CLI: 'claude', AI_CLI_PATH: join(process.cwd(), 'tests/fixtures/fake-image-cli.mjs') });
    await expect(page.getByTestId('image-proposal-mode')).toContainText('モック'); await expect(page.getByTestId('image-proposal-mode')).toContainText('AIのCLIがエラーで終了しました');
    await page.getByRole('button', { name: 'この内容でタスクを作成' }).click(); await expect(page).toHaveURL(/\/tasks\/[^/]+$/); await shot(page, 'fallback-created', size);
  });
  for (const kind of ['large', 'unsupported']) test(`E-${kind === 'large' ? '07' : '08'} クライアントで画像を拒否`, async ({ page }) => {
    await page.locator('#image-task-file').setInputFiles(kind === 'large' ? { ...file, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) } : { name: 'synthetic.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
    await expect(page.getByTestId('image-proposal-error')).toBeFocused(); await expect(page.getByTestId('image-proposal-error')).toContainText(kind === 'large' ? '10MiB' : '対応していない形式'); await shot(page, kind, size);
  });
  test('E-09 HEICの変換と壊れたHEICのエラー', async ({ page }) => {
    await page.locator('#image-task-file').setInputFiles('tests/fixtures/images/synthetic-plain.heic'); await read(page); worker();
    await expect(page.getByRole('heading', { name: '内容を確認' })).toBeVisible(); await page.getByRole('button', { name: 'この内容でタスクを作成' }).click(); await expect(page).toHaveURL(/\/tasks\//); await shot(page, 'heic-created', size);
    await page.goto('/'); await page.locator('#image-task-file').setInputFiles({ name: 'broken.heic', mimeType: 'image/heic', buffer: Buffer.from([0,0,0,24,...Buffer.from('ftypheic'),0,0,0,0,...Buffer.from('heic')]) }); await page.getByRole('button', { name: '画像を読み取る', exact: true }).click(); await expect(page.getByTestId('image-proposal-error')).toContainText('HEICの画像を変換できません'); await shot(page, 'heic-error', size);
  });
  if (size.width === 1280) test('E-10 10MiBちょうどのPNGがproxyを通る', async ({ page }) => {
    test.setTimeout(120_000);
    const buffer = syntheticPng({ byteLength: 10 * 1024 * 1024 });
    expect(buffer.length).toBe(10 * 1024 * 1024);
    await page.locator('#image-task-file').setInputFiles({ ...file, buffer }); await read(page); await expect(page.getByTestId('image-proposal-status')).toContainText('画像を読み取っています'); worker(); await expect(page.getByRole('heading', { name: '内容を確認' })).toBeVisible(); await page.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(page.getByRole('button', { name: '画像を選ぶ', exact: true })).toBeVisible();
    await page.screenshot({ path: join(shots, `${size.name}-limit.png`), animations: 'disabled' });
  });
  test('E-11 E-12 未ログインと操作中のセッション切れ', async ({ page, context, request }) => {
    await choose(page); await context.clearCookies(); await page.getByRole('button', { name: '画像を読み取る', exact: true }).click(); await expect(page).toHaveURL(/\/login/); await page.getByLabel('メールアドレス').fill('owner@example.com'); await page.getByRole('button', { name: /ログイン/ }).click(); await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click(); await expect(page).toHaveURL(/\/login/);
    const anonymous = await request.get('/api/image-proposals/missing/image', { headers: { cookie: '' } }); expect(anonymous.status()).toBe(401); await shot(page, 'login', size);
  });
  test('E-13 取り消しで入力とフォーカスを戻す', async ({ page }) => {
    await start(page); await page.getByRole('button', { name: '取り消す', exact: true }).click();
    const choose = page.locator('label[for="image-task-file"]');
    await expect(choose).toBeVisible();
    await expect(choose).toBeFocused();
    await expect(page.getByRole('button', { name: 'タスクを追加', exact: true })).toBeEnabled(); await shot(page, 'cancelled', size);
  });
  test('E-13 ID受信前の取消も応答後に提案と画像を消す', async ({ page, request }) => {
    let proposalId = '';
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/image-proposals', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      const body = z.object({ proposal: z.object({ id: z.string() }) }).parse(await response.json());
      proposalId = body.proposal.id;
      await held;
      await route.fulfill({ response });
    });
    try {
      await choose(page);
      await page.getByRole('button', { name: '画像を読み取る', exact: true }).click();
      await expect.poll(() => proposalId).not.toBe('');
      await page.getByRole('button', { name: '取り消す', exact: true }).click();
      release();
      await expect(page.locator('label[for="image-task-file"]')).toBeFocused();
      await expect.poll(async () => (await request.get(`/api/image-proposals/${proposalId}`)).status()).toBe(404);
      expect((await request.get(`/api/image-proposals/${proposalId}/image`)).status()).toBe(404);
      expect(await page.evaluate(() => sessionStorage.getItem('image-task-proposal'))).toBeNull();
    } finally { release(); }
  });
  test('E-14 テキストと期限を初期値にして元の入力へ保存', async ({ page }) => {
    await page.getByLabel('新しいタスク', { exact: true }).fill('合成の依頼メモ'); await page.locator('#deadline').fill('2030-11-20'); await ready(page); await expect(page.getByLabel('メモ', { exact: true })).toHaveValue('合成の依頼メモ'); await expect(page.getByLabel('提案の期限')).toHaveValue('2030-11-20'); await page.getByRole('button', { name: 'この内容でタスクを作成' }).click(); await expect(page.locator('.detail-card')).toContainText('合成の依頼メモ'); await shot(page, 'note', size);
  });
  test('E-15 通信失敗5回で停止し再試行、再読み込みで復元', async ({ page }) => {
    await page.route('**/api/image-proposals/*', route => route.request().method() === 'GET' ? route.abort() : route.continue()); await start(page); await expect(page.getByTestId('image-proposal-error')).toContainText('通信できませんでした', { timeout: 20_000 }); await expect(page.getByRole('button', { name: '再試行', exact: true })).toBeVisible(); await shot(page, 'network-error', size); await page.unroute('**/api/image-proposals/*'); worker(); await page.getByRole('button', { name: '再試行', exact: true }).click(); await expect(page.getByRole('heading', { name: '内容を確認' })).toBeVisible(); await page.getByLabel('タイトル', { exact: true }).fill('未保存の編集'); await page.reload(); await expect(page.getByRole('heading', { name: '内容を確認' })).toBeVisible(); await expect(page.getByLabel('タイトル', { exact: true })).not.toHaveValue('未保存の編集'); await page.getByRole('button', { name: 'やめる', exact: true }).click();
  });
  test('E-17 順番待ち、作成中、復旧不能時のID解除', async ({ page, request }) => {
    let phase = 'delayed'; let deletes = 0;
    await page.route('**/api/image-proposals/*', async route => {
      if (route.request().method() === 'DELETE') { deletes++; return route.continue(); }
      const response = await route.fetch(); const body = await response.json();
      await route.fulfill({ json: { ...body, proposal: { ...body.proposal, queueDelayed: phase === 'delayed', status: phase === 'delayed' ? 'QUEUED' : 'CREATING', createStuck: phase === 'stuck' } } });
    });
    await start(page); await expect(page.getByTestId('image-proposal-status')).toContainText('順番を待っています'); await shot(page, 'queue-delayed', size);
    phase = 'creating'; await expect(page.getByTestId('image-proposal-status')).toContainText('作成中…'); await shot(page, 'creating', size);
    phase = 'stuck'; await expect(page.getByTestId('image-proposal-error')).toContainText('作成を完了できません'); await shot(page, 'stuck', size); await page.getByRole('button', { name: '別の画像で始める' }).click(); expect(deletes).toBe(0); await expect(page.locator('label[for="image-task-file"]')).toBeFocused();
    await page.unroute('**/api/image-proposals/*');
    const created = await request.post('/api/tasks', { data: { title: '復旧した合成タスク' }, headers: { 'idempotency-key': crypto.randomUUID() } }); const { task } = await created.json();
    phase = 'creating';
    await page.route('**/api/image-proposals/*', route => route.fulfill({ json: { proposal: { id: 'recovered', status: phase === 'consumed' ? 'CONSUMED' : 'CREATING', image: { name: 'synthetic.jpg', sourceFormat: 'JPEG', width: 1, height: 1, url: '' }, suggestion: null, mode: null, modeLabel: null, fallbackReason: null, taskId: phase === 'consumed' ? task.id : null, queueDelayed: false, createStuck: false, expiresAt: '2099-01-01' } } }));
    await page.evaluate(() => sessionStorage.setItem('image-task-proposal', 'recovered')); await page.reload();
    await expect(page.getByTestId('image-proposal-status')).toContainText('作成中…');
    phase = 'consumed'; await expect(page).toHaveURL(`/tasks/${task.id}`);
  });
});
