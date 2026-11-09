import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { breakdownSnapshotSchema } from '../src/domain/breakdown';
import { buildWorkerEnv, unsafeWebAiEnv } from './helpers/safe-ai-env';

const unsafe = unsafeWebAiEnv(process.env, process.cwd());
if (unsafe) throw new Error(unsafe);
const shots = process.env.SHOT_DIR ?? 'shots';
mkdirSync(shots, { recursive: true });
const taskSchema = z.object({ task: z.object({ id: z.string().uuid() }) });
async function create(request: APIRequestContext) {
  const response = await request.post('/api/tasks', { data: { title: '架空の学習計画', originalInput: '架空の教材で学習する手順を考える', category: 'STUDY' } });
  expect(response.status()).toBe(201); return taskSchema.parse(await response.json()).task;
}
function worker(extra: Record<string, string> = {}) {
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts', '--once'], { timeout: 30000, env: { NODE_ENV: 'test', ...buildWorkerEnv(process.env, extra, process.cwd()) }, stdio: 'pipe' });
}
async function capture(page: Page, name: string, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const sizes = await page.getByRole('region', { name: '分解編集' }).locator('button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(sizes.every((height) => height >= 44)).toBe(true);
  await page.screenshot({ path: join(shots, `${name}-${width}.png`), fullPage: true });
}
for (const width of [390, 1280]) {
  test(`分解の編集・再生成・履歴復元・fallback ${width}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    const task = await create(request);
    expect((await request.post(`/api/tasks/${task.id}/prepare`)).status()).toBe(202); worker();
    await page.goto(`/tasks/${task.id}`);
    const editor = page.getByRole('region', { name: '分解編集' });
    await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('入力内容を論点に分ける');
    await capture(page, 'after', width);
    await editor.getByLabel('項目 1', { exact: true }).fill('架空の教材を読む');
    await editor.getByRole('button', { name: '項目を追加', exact: true }).click();
    await editor.getByLabel('項目 4', { exact: true }).fill('架空の練習問題を解く');
    await editor.getByRole('button', { name: '項目4を上へ' }).click();
    await expect(editor.getByLabel('項目 3', { exact: true })).toHaveValue('架空の練習問題を解く');
    await editor.getByRole('button', { name: '項目3を下へ' }).click();
    await capture(page, 'editing', width);
    await editor.getByRole('button', { name: '項目2を削除' }).click();
    await capture(page, 'deleted', width);
    let releaseSave: () => void = () => {};
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    await page.route(`**/api/tasks/${task.id}/breakdown`, async (route) => { if (route.request().method() === 'POST') await saveGate; await route.continue(); });
    await editor.getByRole('button', { name: 'ユーザー編集版を保存' }).click();
    await expect(editor.getByRole('button', { name: '保存中…' })).toBeDisabled();
    await capture(page, 'saving', width); releaseSave();
    await expect(editor.getByText('ユーザー編集版を保存しました。', { exact: true })).toBeVisible();
    await page.unroute(`**/api/tasks/${task.id}/breakdown`);
    await page.reload();
    await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('架空の教材を読む');
    await editor.getByLabel('項目 1', { exact: true }).fill('未保存の架空の教材を読む');
    await editor.getByLabel('全体コメント', { exact: true }).fill('手順に確認を追加する');
    await editor.getByRole('button', { name: 'このコメントでAIに作り直してもらう' }).click();
    await expect(editor.getByText('AIが分解を作成中… ワーカーの処理を待っています。')).toBeVisible();
    await capture(page, 'generating', width);
    await page.reload();
    await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('未保存の架空の教材を読む');
    worker({ AI_MODE: 'cli', AI_CLI: 'claude', AI_CLI_PATH: join(process.cwd(), 'tests/fixtures/fake-ai-cli.mjs') });
    await expect(editor.getByText('AIが新しい分解版を作成しました。', { exact: true })).toBeVisible();
    await capture(page, 'regenerated-fake-cli', width);
    const snapshot = breakdownSnapshotSchema.parse(await (await request.get(`/api/tasks/${task.id}/breakdown`)).json());
    expect(snapshot.versions.at(-1)?.mode).toBe('ai');
    await editor.locator('summary').click();
    await editor.getByLabel('表示する分解版').selectOption(snapshot.versions[0]!.id);
    await capture(page, 'history', width);
    await editor.getByRole('button', { name: 'この版を復元', exact: true }).click();
    await expect(editor.getByText('新しい復元版を保存しました。', { exact: true })).toBeVisible();
    await capture(page, 'restored', width);
    await editor.getByLabel('全体コメント', { exact: true }).fill('架空の確認を追加する');
    await editor.getByRole('button', { name: 'このコメントでAIに作り直してもらう' }).click();
    await expect(editor.getByText('AIが分解を作成中… ワーカーの処理を待っています。')).toBeVisible();
    worker({ AI_MODE: 'cli', AI_CLI_PATH: join(process.cwd(), 'data/no-such-ai-cli') });
    await expect(editor.locator('[data-mode="mock_fallback"]')).toContainText('CLI_NOT_FOUND');
    await capture(page, 'mock-fallback', width);
    const after = breakdownSnapshotSchema.parse(await (await request.get(`/api/tasks/${task.id}/breakdown`)).json());
    expect(after.versions.at(-1)?.steps).toEqual(snapshot.versions[0]?.steps);
    expect(after.versions).toHaveLength(5);
    expect(await page.locator('html').getAttribute('data-astryx-theme')).toBeNull();
    await page.getByRole('link', { name: '← タスク一覧' }).click();
    await expect(page.getByRole('link', { name: '架空の学習計画' }).first()).toBeVisible();
    expect(await page.locator('html').getAttribute('data-astryx-theme')).toBeNull();
  });
  test(`分解の空・ロード・エラー・認証切れ ${width}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 }); const task = await create(request);
    let release: () => void = () => {}; const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/tasks/${task.id}/breakdown`, async (route) => { await gate; await route.continue(); });
    await page.goto(`/tasks/${task.id}`);
    const editor = page.getByRole('region', { name: '分解編集' });
    await expect(editor.getByText('分解を読み込み中…')).toBeVisible();
    await capture(page, 'loading', width); release();
    await expect(editor.getByText('項目はありません。「項目を追加」から作成できます。')).toBeVisible();
    await capture(page, 'empty', width); await page.unroute(`**/api/tasks/${task.id}/breakdown`);
    await page.route(`**/api/tasks/${task.id}/breakdown`, (route) => route.fulfill({ status: 500, json: { error: '架空の障害' } }));
    await editor.getByRole('button', { name: '最新の版を読み込む' }).click();
    await expect(editor.locator('[data-app-error="true"]')).toContainText('分解を読み込めませんでした');
    await capture(page, 'error', width); await page.unroute(`**/api/tasks/${task.id}/breakdown`);
    await editor.getByRole('button', { name: '最新の版を読み込む' }).click();
    await editor.getByRole('button', { name: '項目を追加', exact: true }).click();
    await editor.getByLabel('項目 1', { exact: true }).fill('架空の教材を読む');
    await page.context().clearCookies();
    await editor.getByRole('button', { name: 'ユーザー編集版を保存' }).click();
    await expect(editor.locator('[data-app-error="true"]')).toContainText('ログインし直してください');
    await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('架空の教材を読む');
    await capture(page, 'auth-expired', width);
  });
}
test('未ログインの詳細と分解APIは保護される', async ({ page, request }) => {
  const task = await create(request); await page.context().clearCookies();
  await page.goto(`/tasks/${task.id}`); await expect(page).toHaveURL(/\/login\?next=/);
  const response = await page.request.get(`/api/tasks/${task.id}/breakdown`); expect(response.status()).toBe(401);
});


test('待機中の別保存・競合入力の明示回収と破棄', async ({ page, request }) => {
  const task = await create(request); const url = `/api/tasks/${task.id}/breakdown`;
  expect((await request.post(url, { data: { action: 'save', baseVersion: null, requestKey: 'initial', steps: ['保存済みの手順'] } })).status()).toBe(200);
  await page.goto(`/tasks/${task.id}`);
  const editor = page.getByRole('region', { name: '分解編集' });
  await editor.getByLabel('項目 1', { exact: true }).fill('生成に渡した手順');
  await editor.getByLabel('全体コメント', { exact: true }).fill('生成時のコメント');
  await editor.getByRole('button', { name: 'このコメントでAIに作り直してもらう' }).click();
  await expect(editor.getByText('AIが分解を作成中… ワーカーの処理を待っています。')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'このコメントでAIに作り直してもらう' })).toBeDisabled();
  await editor.getByLabel('項目 1', { exact: true }).fill('待機中に別保存する手順');
  await editor.getByRole('button', { name: 'ユーザー編集版を保存' }).click();
  await expect(editor.getByText('ユーザー編集版を保存しました。', { exact: true })).toBeVisible();
  worker();
  await expect(editor.locator('[data-app-error="true"]')).toContainText('AIの作成中に分解かタスクが更新されたため、AIの結果は使いませんでした。');
  await page.reload();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('待機中に別保存する手順');
  await editor.getByText('完了しなかった作り直しの入力（1件）', { exact: true }).click();
  await editor.getByRole('button', { name: '未完了入力1を編集に戻す' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('生成に渡した手順');
  await expect(editor.getByLabel('全体コメント', { exact: true })).toHaveValue('生成時のコメント');
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: '最新の版を読み込む' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('待機中に別保存する手順');
  await expect(editor.getByLabel('全体コメント', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('待機中に別保存する手順');
});

for (const field of ['steps', 'comment']) test(`生成開始後の未保存編集${field}を結果で上書きせずモック完了を通知する`, async ({ page, request }) => {
  const task = await create(request);
  await page.goto(`/tasks/${task.id}`);
  const editor = page.getByRole('region', { name: '分解編集' });
  await editor.getByRole('button', { name: '項目を追加', exact: true }).click();
  await editor.getByLabel('項目 1', { exact: true }).fill('生成入力');
  await editor.getByLabel('全体コメント', { exact: true }).fill('整理する');
  await editor.getByRole('button', { name: 'このコメントでAIに作り直してもらう' }).click();
  await expect(editor.getByText('AIが分解を作成中… ワーカーの処理を待っています。')).toBeVisible();
  if (field === 'steps') await editor.getByLabel('項目 1', { exact: true }).fill('生成後の未保存編集');
  else await editor.getByLabel('全体コメント', { exact: true }).fill('生成後のコメント');
  worker();
  await expect(editor.getByRole('status').filter({ hasText: 'モック' })).toContainText('内容は変わっていません');
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue(field === 'steps' ? '生成後の未保存編集' : '生成入力');
  await expect(editor.getByLabel('全体コメント', { exact: true })).toHaveValue(field === 'comment' ? '生成後のコメント' : '整理する');
  await expect(editor.getByText('編集中・未保存', { exact: true })).toBeVisible();
  const data = breakdownSnapshotSchema.parse(await (await request.get(`/api/tasks/${task.id}/breakdown`)).json());
  expect(data.versions.at(-1)?.steps).toEqual(['生成入力']);
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: '最新の版を読み込む' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('生成入力');
});

test('追加・連続移動・削除・取り消しで対象項目へフォーカスする', async ({ page, request }) => {
  const task = await create(request); await page.goto(`/tasks/${task.id}`);
  const editor = page.getByRole('region', { name: '分解編集' });
  for (let index = 1; index <= 3; index++) {
    await editor.getByRole('button', { name: '項目を追加', exact: true }).click();
    const input = editor.getByLabel(`項目 ${index}`, { exact: true });
    await expect(input).toBeFocused(); await input.fill(`手順${index}`);
  }
  await editor.getByRole('button', { name: '項目3を上へ' }).click();
  await expect(editor.getByLabel('項目 2', { exact: true })).toBeFocused();
  await expect(editor.getByLabel('項目 2', { exact: true })).toHaveValue('手順3');
  await editor.getByRole('button', { name: '項目2を上へ' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toBeFocused();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('手順3');
  await editor.getByRole('button', { name: '項目1を削除' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toBeFocused();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('手順1');
  await editor.getByRole('button', { name: '削除を取り消す' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toBeFocused();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('手順3');
  for (let remaining = 3; remaining > 0; remaining--) await editor.getByRole('button', { name: '項目1を削除' }).click();
  await expect(editor.getByRole('button', { name: '項目を追加', exact: true })).toBeFocused();
  await editor.getByRole('button', { name: '削除を取り消す' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toBeFocused();
});

test('初回401をログイン案内にする', async ({ page, request }) => {
  const task = await create(request);
  await page.route(`**/api/tasks/${task.id}/breakdown`, (route) => route.fulfill({ status: 401, json: { error: 'ログインが必要です。' } }));
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('region', { name: '分解編集' }).locator('[data-app-error="true"]')).toContainText('ログインし直してください');
});


test('基準版が同じ失敗入力も自動復活せず明示回収後に破棄できる', async ({ page, request }) => {
  const task = await create(request); const url = `/api/tasks/${task.id}/breakdown`;
  const response = await request.post(url, { data: { action: 'save', baseVersion: null, requestKey: 'initial', steps: ['最新版'] } });
  const initial = breakdownSnapshotSchema.parse(await response.json());
  const failed = breakdownSnapshotSchema.parse({ ...initial, jobs: [{ id: randomUUID(), taskId: task.id, status: 'FAILED', baseVersion: initial.versions[0]!.id, inputSteps: ['失敗入力'], comment: '失敗時コメント', errorCode: 'GENERATION_FAILED', createdAt: new Date().toISOString() }] });
  await page.route(`**${url}`, (route) => route.fulfill({ status: 200, json: failed }));
  await page.goto(`/tasks/${task.id}`);
  const editor = page.getByRole('region', { name: '分解編集' });
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('最新版');
  await editor.getByText('完了しなかった作り直しの入力（1件）', { exact: true }).click();
  await editor.getByRole('button', { name: '未完了入力1を編集に戻す' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('失敗入力');
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: '最新の版を読み込む' }).click();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('最新版');
  await expect(editor.getByLabel('全体コメント', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue('最新版');
});


for (const status of ['COMPLETED', 'CANCELLED']) test(`${status}の旧長文・多項目を全文表示し編集を無効にする`, async ({ page, request }) => {
  const task = await create(request); const url = `/api/tasks/${task.id}/breakdown`;
  const response = await request.post(url, { data: { action: 'save', baseVersion: null, requestKey: 'initial', steps: ['仮の初版'] } });
  const initial = breakdownSnapshotSchema.parse(await response.json());
  const steps = ['  ' + '旧'.repeat(301) + '  ', ...Array.from({ length: 51 }, (_, i) => `旧手順${i + 1}`)];
  const legacy = breakdownSnapshotSchema.parse({ ...initial, versions: initial.versions.map((version) => ({ ...version, kind: 'import', steps })) });
  expect((await request.patch(`/api/tasks/${task.id}`, { data: { status } })).status()).toBe(200);
  await page.route(`**${url}`, (route) => route.fulfill({ status: 200, json: legacy }));
  await page.goto(`/tasks/${task.id}`);
  const editor = page.getByRole('region', { name: '分解編集' });
  await expect(editor.getByLabel('項目 1', { exact: true })).toHaveValue(steps[0]!);
  await expect(editor.getByLabel('項目 52', { exact: true })).toHaveValue('旧手順51');
  await expect(editor.getByLabel('項目 1', { exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'ユーザー編集版を保存' })).toBeDisabled();
  await editor.locator('summary').click();
  await editor.getByLabel('表示する分解版').selectOption(legacy.versions[0]!.id);
  await expect(editor.getByRole('button', { name: 'この版を復元' })).toBeDisabled();
  await expect(editor.locator('[aria-label="過去の分解"] li')).toHaveCount(52);
});
