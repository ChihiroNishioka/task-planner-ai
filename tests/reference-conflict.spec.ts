import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { z } from 'zod';
import { referenceSchema } from '../src/domain/references';
import { requiredDirectory } from './helpers/required-e2e-directory';

requiredDirectory('E2E_DATA_DIR', process.env.E2E_DATA_ROOT ?? '/workspace/dev/tp-mid-data');
const shots = requiredDirectory('SHOT_DIR', process.env.E2E_SHOT_ROOT ?? '/workspace/dev/tp-mid-runs');
const savedSchema = z.object({ reference: referenceSchema });
const writeHeaders = (baseURL: string | undefined) => ({ origin: new URL(baseURL ?? 'http://127.0.0.1:3100').origin, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() });
async function editNote(page: Page, request: APIRequestContext) {
  const response = await request.post('/api/tasks', { data: { title: 'メモ競合の合成タスク', category: 'STUDY' } });
  expect(response.status()).toBe(201);
  const { task } = z.object({ task: z.object({ id: z.string() }) }).parse(await response.json());
  const endpoint = `/api/tasks/${task.id}/references`;
  await page.goto(`/tasks/${task.id}`);
  const panel = page.locator('[data-reference-panel]');
  await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
  await panel.getByLabel('メモの題名（任意）').fill('元の題名');
  await panel.getByLabel('メモの本文').fill('元のメモ本文');
  await panel.getByRole('button', { name: 'メモを保存', exact: true }).click();
  const note = panel.locator('[data-reference-kind="NOTE"]');
  await expect(note).toContainText('元のメモ本文');
  const list = z.object({ references: z.array(referenceSchema) }).parse(await (await request.get(endpoint)).json());
  expect(list.references).toHaveLength(1);
  await note.getByRole('button', { name: '編集', exact: true }).click();
  await panel.getByLabel('メモの題名（任意）').fill('保持する題名');
  await panel.getByLabel('メモの本文').fill('保持する入力本文');
  return { panel, endpoint, note: list.references[0] };
}
async function checkLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const heights = await page.locator('[data-reference-panel]').getByRole('button').evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().height > 0).map(button => button.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(heights.every(height => height >= 44)).toBe(true);
}
async function capture(page: Page, width: number) {
  await checkLayout(page, width);
  await page.screenshot({ path: join(shots, `note-conflict-${width}.png`), fullPage: true });
}
for (const width of [390, 1280]) {
  test(`G-R1-e2e 最新のメモを比較して入力を載せ替える ${width}px`, async ({ page, request, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    const { panel, endpoint, note } = await editNote(page, request);
    const updated = await request.patch(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL), data: { title: '別の場所の題名', body: '別の場所の最新本文', revision: note.revision } });
    expect(updated.status()).toBe(200);
    const latest = savedSchema.parse(await updated.json()).reference;
    const conflict = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`${endpoint}/${note.id}`));
    await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(panel.locator('[data-ref-error]')).toContainText('入力を保持');
    const comparison = panel.getByRole('region', { name: '最新のメモ', exact: true });
    await expect(comparison).toBeFocused();
    await expect(comparison).toHaveCSS('outline-style', 'solid');
    await expect(comparison).toHaveCSS('outline-width', '3px');
    await expect(comparison.getByRole('heading', { name: '別の場所の題名', exact: true })).toBeVisible();
    await expect(comparison).toHaveCSS('border-top-style', 'solid');
    await expect(comparison).toContainText('別の場所の題名');
    await expect(comparison).toContainText('別の場所の最新本文');
    await expect(panel.getByLabel('メモの題名（任意）')).toHaveValue('保持する題名');
    await expect(panel.getByLabel('メモの本文')).toHaveValue('保持する入力本文');
    await capture(page, width);
    const writes: string[] = [];
    const record = (request: Request) => {
      if (request.url().includes(endpoint) && ['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method());
    };
    page.on('request', record);
    await comparison.getByRole('button', { name: '入力中の内容を最新のメモに載せ替える', exact: true }).click();
    await expect(comparison).toHaveCount(0);
    expect(writes).toEqual([]);
    const unchanged = z.object({ references: z.array(referenceSchema) }).parse(await (await request.get(endpoint)).json());
    expect(unchanged.references.find(item => item.id === note.id)?.revision).toBe(latest.revision);
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`${endpoint}/${note.id}`));
    await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
    expect((await saved).status()).toBe(200);
    page.off('request', record);
    await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('保持する入力本文');
    await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('保持する題名');
  });
}

test('G-R1-404-e2e 削除されたメモの入力を新しいメモとして保存する 390px', async ({ page, request, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { panel, endpoint, note } = await editNote(page, request);
  expect((await request.delete(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL) })).status()).toBe(204);
  const missing = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`${endpoint}/${note.id}`));
  await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
  expect((await missing).status()).toBe(404);
  await expect(panel.locator('[data-ref-error]')).toContainText('このメモは削除されました。保存すると新しいメモとして追加します。');
  await expect(panel.getByLabel('メモの題名（任意）')).toHaveValue('保持する題名');
  await expect(panel.getByLabel('メモの本文')).toHaveValue('保持する入力本文');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(endpoint));
  await panel.getByRole('button', { name: 'メモを保存', exact: true }).click();
  expect((await saved).status()).toBe(201);
  const replacement = savedSchema.parse(await (await saved).json()).reference;
  expect(replacement.id).not.toBe(note.id);
  await expect(panel.locator('[data-reference-kind="NOTE"]')).toHaveCount(1);
  await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('保持する入力本文');
  await checkLayout(page, 390);
});

test('R1の競合後に一覧取得が失敗しても入力を保持し再読み込みから比較できる', async ({ page, request, baseURL }) => {
  const { panel, endpoint, note } = await editNote(page, request);
  expect((await request.patch(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL), data: { title: '最新の題名', body: '最新の本文', revision: note.revision } })).status()).toBe(200);
  let fail = true;
  await page.route(`**${endpoint}`, route => route.request().method() === 'GET' && fail
    ? route.fulfill({ status: 503, json: {} }) : route.continue());
  await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
  await expect(panel.locator('[data-ref-error]').filter({ hasText: '資料を読み込めませんでした' })).toBeVisible();
  await expect(panel.getByRole('region', { name: '最新のメモ', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('メモの題名（任意）')).toHaveValue('保持する題名');
  await expect(panel.getByLabel('メモの本文')).toHaveValue('保持する入力本文');
  fail = false;
  await panel.getByRole('button', { name: '資料を再読み込み', exact: true }).click();
  await expect(panel.getByRole('region', { name: '最新のメモ', exact: true })).toContainText('最新の本文');
});

test('409後の一覧取得前に消えたメモは入力を保持して新規保存できる', async ({ page, request, baseURL }) => {
  const { panel, endpoint, note } = await editNote(page, request);
  await page.route(`**${endpoint}/${note.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    expect((await request.delete(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL) })).status()).toBe(204);
    await route.fulfill({ status: 409, json: { code: 'CONFLICT' } });
  });
  await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
  await expect(panel.locator('[data-ref-error]')).toContainText('このメモは削除されました。保存すると新しいメモとして追加します。');
  await expect(panel.getByRole('region', { name: '最新のメモ', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('メモの題名（任意）')).toHaveValue('保持する題名');
  await expect(panel.getByLabel('メモの本文')).toHaveValue('保持する入力本文');
  const save = panel.getByRole('button', { name: 'メモを保存', exact: true });
  await expect(save).toBeEnabled();
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(endpoint));
  await save.click();
  expect((await saved).status()).toBe(201);
  const replacement = savedSchema.parse(await (await saved).json()).reference;
  expect(replacement.id).not.toBe(note.id);
  await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('保持する入力本文');
});

test('URLのエラーはメモの編集開始・リセット・載せ替えで消えない', async ({ page, request, baseURL }) => {
  const { panel, endpoint, note } = await editNote(page, request);
  await page.route(`**${endpoint}`, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 422, json: {} }) : route.continue());
  await panel.getByRole('tab', { name: 'URL', exact: true }).click();
  await panel.getByLabel('関連するURL').fill('https://example.com/');
  await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
  const urlError = panel.locator('[data-ref-error]').filter({ hasText: '入力内容または資料の上限を確認してください。' });
  await expect(urlError).toBeVisible();
  await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
  await panel.getByRole('button', { name: '編集をやめる', exact: true }).click();
  await expect(urlError).toBeVisible();
  await panel.locator('[data-reference-kind="NOTE"]').getByRole('button', { name: '編集', exact: true }).click();
  await expect(urlError).toBeVisible();
  expect((await request.patch(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL), data: { title: '最新の題名', body: '最新の本文', revision: note.revision } })).status()).toBe(200);
  await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
  await panel.getByRole('button', { name: '入力中の内容を最新のメモに載せ替える', exact: true }).click();
  await expect(urlError).toBeVisible();
});


for (const recovery of ['手動再読み込み', '定期監視'] as const) {
  test(`R2-01 409直後のGET失敗中に消えたメモを${recovery}で新規保存へ戻す`, async ({ page, request, baseURL }) => {
    const { panel, endpoint, note } = await editNote(page, request);
    expect((await request.patch(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL), data: { title: '最新の題名', body: '最新の本文', revision: note.revision } })).status()).toBe(200);
    let fail = true;
    await page.route(`**${endpoint}`, route => route.request().method() === 'GET' && fail
      ? route.fulfill({ status: 503, json: {} }) : route.continue());
    const conflict = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`${endpoint}/${note.id}`));
    await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(panel.locator('[data-ref-error]').filter({ hasText: '資料を読み込めませんでした' })).toBeVisible();
    expect((await request.delete(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL) })).status()).toBe(204);
    fail = false;
    if (recovery === '手動再読み込み') await panel.getByRole('button', { name: '資料を再読み込み', exact: true }).click();
    await expect(panel.locator('[data-ref-error]').filter({ hasText: 'このメモは削除されました。保存すると新しいメモとして追加します。' })).toBeVisible({ timeout: 10000 });
    await expect(panel.locator('[data-ref-error]')).toHaveCount(1);
    await expect(panel.getByRole('region', { name: '最新のメモ', exact: true })).toHaveCount(0);
    await expect(panel.getByLabel('メモの題名（任意）')).toHaveValue('保持する題名');
    await expect(panel.getByLabel('メモの本文')).toHaveValue('保持する入力本文');
    const save = panel.getByRole('button', { name: 'メモを保存', exact: true });
    await expect(save).toBeEnabled();
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(endpoint));
    await save.click();
    const response = await saved;
    expect(response.status()).toBe(201);
    expect(savedSchema.parse(await response.json()).reference.id).not.toBe(note.id);
    await expect(panel.locator('[data-reference-kind="NOTE"]')).toHaveCount(1);
    await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('保持する入力本文');
  });
}

test('R2-02 定期GETが成功してもメモ本文のフォーカスを奪わない', async ({ page, request, baseURL }) => {
  const { panel, endpoint, note } = await editNote(page, request);
  expect((await request.patch(`${endpoint}/${note.id}`, { headers: writeHeaders(baseURL), data: { title: '最新の題名', body: '最新の本文', revision: note.revision } })).status()).toBe(200);
  let gets = 0;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const data = z.object({ references: z.array(referenceSchema) }).parse(await response.json());
    gets += 1;
    const fetching = referenceSchema.parse({
      ...note, id: 'fixture-fetching-url', kind: 'URL', title: `監視${gets}`, body: '',
      url: 'https://example.com/', finalUrl: null, fetchStatus: 'FETCHING', fetchErrorCode: null,
      fetchMode: 'fixture', fetchedAt: null, contentType: null, truncated: false,
    });
    await route.fulfill({ response, json: { references: [...data.references, fetching] } });
  });
  await panel.getByRole('button', { name: '変更を保存', exact: true }).click();
  const comparison = panel.getByRole('region', { name: '最新のメモ', exact: true });
  await expect(comparison).toBeFocused();
  const body = panel.getByLabel('メモの本文');
  await body.focus();
  const firstGet = gets;
  for (let count = 1; count <= 3; count += 1) {
    await expect(panel.locator('[data-reference-kind="URL"]')).toContainText(`監視${firstGet + count}`, { timeout: 10000 });
    await expect(body).toBeFocused();
  }
  await expect(body).toHaveValue('保持する入力本文');
});
