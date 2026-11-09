import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { draftFlowSnapshotSchema } from '../src/domain/draft-flow';
import { breakdownSnapshotSchema } from '../src/domain/breakdown';
import { requiredDirectory } from './helpers/required-e2e-directory';
import { buildWorkerEnv, unsafeWebAiEnv } from './helpers/safe-ai-env';

const data = requiredDirectory('E2E_DATA_DIR', process.env.E2E_DATA_ROOT ?? '/workspace/dev/tp-draft-data');
const shots = requiredDirectory('SHOT_DIR', process.env.E2E_SHOT_ROOT ?? '/workspace/dev/tp-draft-runs');
const unsafeReason = unsafeWebAiEnv(process.env, process.cwd());
if (unsafeReason) throw new Error(unsafeReason);
const viewports = [{ name: 'iphone-390x844', width: 390, height: 844 }, { name: 'pc-1280x800', width: 1280, height: 800 }];
const draftUrl = (id: string) => `/api/tasks/${id}/draft`;
const panel = (page: Page) => page.getByRole('region', { name: 'ドラフト作成', exact: true });
const createButton = (page: Page) => panel(page).getByRole('button', { name: 'この分解でドラフトを作る', exact: true });
const editor = (page: Page) => page.getByRole('region', { name: '分解編集', exact: true });
async function snapshot(request: APIRequestContext, id: string) { return draftFlowSnapshotSchema.parse(await (await request.get(draftUrl(id))).json()); }
async function breakdown(request: APIRequestContext, id: string) { return breakdownSnapshotSchema.parse(await (await request.get(`/api/tasks/${id}/breakdown`)).json()); }
function worker() {
  const env = buildWorkerEnv(process.env, {}, process.cwd());
  env.DATABASE_PATH = join(data, 'playwright.sqlite');
  env.BLOB_DIRECTORY = join(data, 'playwright-blobs');
  env.ARTIFACT_DIRECTORY = join(data, 'playwright-artifacts');
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts', '--once'], { timeout: 30_000, env: { ...env, NODE_ENV: 'test' }, stdio: 'pipe' });
}
async function seed(request: APIRequestContext, prepared = true) {
  const response = await request.post('/api/tasks', { headers: { 'idempotency-key': randomUUID() }, data: { title: `ドラフト連携 ${randomUUID()}`, category: 'WORK', originalInput: '合成データで作業計画を作る' } });
  expect(response.status()).toBe(201);
  const { task } = await response.json() as { task: { id: string } };
  if (prepared) {
    expect((await request.post(`/api/tasks/${task.id}/prepare`, { headers: { 'idempotency-key': randomUUID() } })).status()).toBe(202);
    worker();
  }
  return task.id;
}
async function createDraft(request: APIRequestContext, id: string) {
  const flow = await snapshot(request, id);
  expect((await request.post(draftUrl(id), { data: { action: 'create', breakdownVersionId: flow.breakdown.latestVersionId, requestKey: randomUUID() } })).status()).toBe(202);
  worker();
}
async function changeBreakdown(request: APIRequestContext, id: string, steps: string[]) {
  const current = await breakdown(request, id);
  expect((await request.post(`/api/tasks/${id}/breakdown`, { data: { action: 'save', baseVersion: current.versions.at(-1)?.id ?? null, requestKey: randomUUID(), steps } })).status()).toBe(200);
}
async function capture(page: Page, name: string, viewport: typeof viewports[number]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  for (const button of await page.locator('[aria-label="ドラフト作成"] button, [aria-label="ドラフトの分解変更案内"] button, [role="dialog"] button').all()) {
    if (await button.isVisible()) expect(await button.evaluate(node => (node as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: join(shots, `${viewport.name}-${name}.png`), fullPage: true, animations: 'disabled' });
}
for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize(viewport); });
    test('DF-E01 初回は再読込せず分解だけを表示する', async ({ page, request }) => {
      const id = await seed(request, false);
      await page.goto(`/tasks/${id}`);
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/api/tasks/${id}/prepare`) && response.request().method() === 'POST'),
        page.getByRole('button', { name: 'AI準備を依頼', exact: true }).click(),
      ]);
      worker();
      await expect(editor(page).getByLabel('項目 1', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'AIの準備結果' })).toHaveCount(0);
      await expect(page.getByText('分解ができました。内容を確認して「この分解でドラフトを作る」を押してください。', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'AIで分解を作り直す', exact: true })).toBeVisible();
      expect((await snapshot(request, id)).draft).toBeNull();
      await capture(page, 'draft-breakdown-only', viewport);
    });
    test('DF-E02 DF-E03 編集保存した分解をドラフトに反映しフォーカスを戻す', async ({ page, request }) => {
      const id = await seed(request);
      await page.goto(`/tasks/${id}`);
      await editor(page).getByLabel('項目 1', { exact: true }).fill('編集済みの最初の手順を確認する');
      await expect(createButton(page)).toBeDisabled();
      await expect(panel(page)).toContainText('未保存の変更があります。');
      await editor(page).getByRole('button', { name: 'ユーザー編集版を保存' }).click();
      await expect(createButton(page)).toBeEnabled();
      await capture(page, 'draft-button', viewport);
      await createButton(page).click();
      await expect(panel(page).locator('[data-draft-status]')).toBeFocused();
      await expect(panel(page).getByRole('button', { name: 'ドラフトを作成中…' })).toBeDisabled();
      worker();
      await expect(page.getByRole('heading', { name: 'ドラフト v1', exact: true })).toBeVisible();
      await expect(panel(page).locator('[data-draft-status]')).toHaveText('ドラフト v1 を作成しました。');
      await expect(panel(page).locator('[data-draft-status]')).toBeFocused();
      const saved = (await breakdown(request, id)).versions.at(-1)!;
      const content = page.locator('.ai-draft');
      for (const [index, step] of saved.steps.entries()) await expect(content).toContainText(`## ${index + 1}. ${step}`);
      await expect(page.getByRole('region', { name: 'AIの準備結果' }).locator('.mode-badge')).toContainText('モック');
      await capture(page, 'draft-following-breakdown', viewport);
    });
    test('DF-E04 DF-E05 DF-E06 詳細とレビューの変更案内から作り直し、改訂は分解を変えない', async ({ page, request }) => {
      const id = await seed(request);
      await createDraft(request, id);
      await changeBreakdown(request, id, ['新しい手順を確認する', '新しい下書きをまとめる']);
      await page.goto(`/tasks/${id}`);
      await expect(panel(page)).toContainText('分解が変わっています。ドラフトを作り直しますか？');
      await capture(page, 'draft-stale-notice', viewport);
      await page.goto(`/tasks/${id}/review`);
      const notice = page.getByRole('region', { name: 'ドラフトの分解変更案内', exact: true });
      await expect(notice).toContainText('分解が変わっています。ドラフトを作り直しますか？');
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith(draftUrl(id)) && response.request().method() === 'POST'),
        notice.getByRole('button', { name: 'この分解でドラフトを作り直す' }).click(),
      ]);
      worker();
      await expect(page.getByRole('heading', { name: 'v2', exact: true })).toBeVisible();
      await expect(page.getByText('分解が変わっています。ドラフトを作り直しますか？', { exact: true })).toHaveCount(0);
      const before = await breakdown(request, id);
      await page.getByLabel('修正指示').fill('結論を先に書いてください');
      await page.getByRole('button', { name: '修正版を作る', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'v3', exact: true })).toBeVisible();
      expect((await breakdown(request, id)).versions).toEqual(before.versions);
      await capture(page, 'draft-after-comment', viewport);
    });
    test('DF-E07 分解なし、0件、完了で理由を示して無効にする', async ({ page, request }) => {
      const id = await seed(request, false);
      await page.goto(`/tasks/${id}`);
      await expect(createButton(page)).toBeDisabled();
      await expect(panel(page)).toContainText('先に「AI準備を依頼」で分解を作るか');
      await changeBreakdown(request, id, []);
      await expect(panel(page)).toContainText('分解の項目を1件以上保存すると');
      await expect(createButton(page)).toBeDisabled();
      expect((await request.patch(`/api/tasks/${id}`, { data: { status: 'COMPLETED' } })).status()).toBe(200);
      await expect(panel(page)).toContainText('完了・中止したタスクでは');
      await expect(createButton(page)).toBeDisabled();
    });
    test('DF-E08 GET失敗と作成失敗を表示し再試行で回復する', async ({ page, request }) => {
      const id = await seed(request);
      let failRead = true;
      let failCreate = true;
      await page.route(`**${draftUrl(id)}`, route => {
        if (route.request().method() === 'GET' && failRead) return route.fulfill({ status: 503, json: {} });
        if (route.request().method() === 'POST' && failCreate) return route.fulfill({ status: 503, json: { error: 'ドラフトを作成できませんでした。もう一度お試しください。' } });
        return route.continue();
      });
      await page.goto(`/tasks/${id}`);
      await expect(panel(page).locator('[data-draft-error]')).toContainText('ドラフトの状態を取得できません。');
      await expect(createButton(page)).toBeDisabled();
      failRead = false;
      // 失敗後も自動の再取得が続くので、押す前に自動で回復してボタンが消えることがある（e2e で確認）。
      // 押せたときは手動の再取得で、消えたときは自動の再取得で回復したことを確かめる。
      const retryRead = panel(page).getByRole('button', { name: 'ドラフトの状態を再取得' });
      await retryRead.dispatchEvent('click', undefined, { timeout: 3000 }).catch(async () => { await expect(retryRead).toHaveCount(0); });
      await expect(panel(page).locator('[data-draft-error]')).toHaveCount(0);
      await expect(createButton(page)).toBeEnabled();
      await createButton(page).click();
      await expect(panel(page).locator('[data-draft-error]')).toContainText('ドラフトを作成できませんでした。');
      failCreate = false;
      // 「作成中…」は POST 送信中から出るので、ジョブが保存された（202 が返った）後に状態を読む。
      await Promise.all([
        page.waitForResponse(r => r.url().endsWith(draftUrl(id)) && r.request().method() === 'POST' && r.status() === 202),
        createButton(page).click(),
      ]);
      await expect(panel(page).getByRole('button', { name: 'ドラフトを作成中…' })).toBeDisabled();
      const queued = await snapshot(request, id);
      expect(queued.job?.status).toBe('QUEUED');
      await page.unroute(`**${draftUrl(id)}`);
      await page.route(`**${draftUrl(id)}`, route => route.request().method() === 'GET'
        ? route.fulfill({ json: { ...queued, canCreate: true, blockReason: null, job: { ...queued.job, status: 'FAILED', errorCode: 'GENERATION_FAILED', message: 'ドラフトを作成できませんでした。もう一度お試しください。' } } })
        : route.continue());
      await expect(panel(page).locator('[data-draft-error]')).toContainText('ドラフトを作成できませんでした。');
      await expect(createButton(page)).toBeFocused();
      await page.unroute(`**${draftUrl(id)}`);
      expect((await request.post(draftUrl(id), { data: { action: 'cancel', jobId: queued.job!.id } })).status()).toBe(200);
      await expect(createButton(page)).toBeEnabled();
      await createButton(page).click();
      await expect(panel(page).getByRole('button', { name: 'ドラフトを作成中…' })).toBeDisabled();
      worker();
      await expect(page.getByRole('heading', { name: 'ドラフト v1', exact: true })).toBeVisible();
    });
    test('DF-E09 取消後は作成ボタンにフォーカスが戻り結果を保存しない', async ({ page, request }) => {
      const id = await seed(request);
      await page.goto(`/tasks/${id}`);
      await expect(createButton(page)).toBeEnabled();
      await createButton(page).click();
      await expect(panel(page).locator('[data-draft-status]')).toBeFocused();
      await panel(page).getByRole('button', { name: 'ドラフト作成を取り消す' }).click();
      await expect(createButton(page)).toBeEnabled();
      await expect(createButton(page)).toBeFocused();
      worker();
      expect((await snapshot(request, id)).draft).toBeNull();
    });
    test('DF-E11 再読み込み中に利用者が選んだフォーカスを保持する', async ({ page, request }) => {
      const id = await seed(request);
      await page.goto(`/tasks/${id}`);
      await expect(createButton(page)).toBeEnabled();
      await page.addInitScript(() => {
        const focusLink = () => {
          const link = Array.from(document.querySelectorAll('a')).find(node => node.textContent === '← タスク一覧');
          if (!link) return;
          link.focus();
          observer.disconnect();
        };
        const observer = new MutationObserver(focusLink);
        document.addEventListener('DOMContentLoaded', () => {
          observer.observe(document, { childList: true, subtree: true });
          focusLink();
        }, { once: true });
      });
      await createButton(page).click();
      await expect(panel(page).locator('[data-draft-status]')).toBeFocused();
      worker();
      await expect(page.getByRole('heading', { name: 'ドラフト v1', exact: true })).toBeVisible();
      await expect(panel(page).locator('[data-draft-status]')).toHaveText('ドラフト v1 を作成しました。');
      await expect(page.getByRole('link', { name: '← タスク一覧', exact: true })).toBeFocused();
      await page.waitForResponse(response => response.url().endsWith(draftUrl(id)) && response.request().method() === 'GET');
      await expect(page.getByRole('link', { name: '← タスク一覧', exact: true })).toBeFocused();
    });
    test('DF-E12 遷移が遅くても旧ページは受け渡しキーを使わない', async ({ page, request }) => {
      const id = await seed(request);
      await page.goto(`/tasks/${id}`);
      await expect(createButton(page)).toBeEnabled();
      await createButton(page).click();
      await expect(panel(page).locator('[data-draft-status]')).toBeFocused();
      let releaseNavigation = () => {};
      let notifyHeld = () => {};
      const navigationHeld = new Promise<void>(resolve => { notifyHeld = resolve; });
      const release = new Promise<void>(resolve => { releaseNavigation = resolve; });
      await page.route(`**/tasks/${id}`, async route => {
        if (!route.request().isNavigationRequest()) return route.continue();
        // route.fetch() + fulfill だと Chromium の Local Network Access で新しいページの 127.0.0.1 への読み込みが止まり、
        // ハイドレーションされない（e2e で確認）。要求を送らずに止めておき、解放後にそのまま流す。
        notifyHeld();
        await release;
        await route.continue();
      });
      worker();
      const created = (await snapshot(request, id)).draft!;
      try {
        await navigationHeld;
        // 遷移を止めている間はページ内でコードを実行できない（page.evaluate が遷移を待つ）ので、
        // 旧ページのポーリング間隔（成功後 5000ms）を越えて待つだけにし、キーが残ったかは新しいページの表示で確かめる。
        expect(created.versionId).toBeTruthy();
        await page.waitForTimeout(6500);
      } finally {
        releaseNavigation();
      }
      await expect(page.getByRole('heading', { name: 'ドラフト v1', exact: true })).toBeVisible();
      await expect(panel(page).locator('[data-draft-status]')).toHaveText('ドラフト v1 を作成しました。');
      await expect(panel(page).locator('[data-draft-status]')).toBeFocused();
      expect(await page.evaluate(key => sessionStorage.getItem(key), `draft-flow-created:${id}`)).toBeNull();
    });
    test('DF-E10 作成中の未保存入力は完了後も保持する', async ({ page, request }) => {
      const id = await seed(request);
      await page.goto(`/tasks/${id}`);
      await expect(createButton(page)).toBeEnabled();
      await createButton(page).click();
      await expect(panel(page).getByRole('button', { name: 'ドラフトを作成中…' })).toBeDisabled();
      await editor(page).getByLabel('項目 1', { exact: true }).fill('作成中も保持する入力');
      await editor(page).getByLabel('全体コメント', { exact: true }).fill('作成後も残すコメント');
      worker();
      await expect(panel(page)).toContainText('編集中の分解は保持しています。');
      await expect(panel(page).getByRole('button', { name: 'ドラフトを表示（ページを再読み込み）' })).toBeVisible();
      await expect(editor(page).getByLabel('項目 1', { exact: true })).toHaveValue('作成中も保持する入力');
      await expect(editor(page).getByLabel('全体コメント', { exact: true })).toHaveValue('作成後も残すコメント');
      await expect(page.getByRole('region', { name: 'AIの準備結果' })).toHaveCount(0);
    });
  });
}
