import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { referenceSchema, type Reference } from '../src/domain/references';

const shots = process.env.SHOT_DIR ?? 'test-results/reference-shots';
mkdirSync(shots, { recursive: true });
async function task(request: APIRequestContext) {
  const response = await request.post('/api/tasks', { headers: { 'idempotency-key': crypto.randomUUID() }, data: { title: '関連資料の合成タスク', originalInput: '関連資料の検証', category: 'WORK' } });
  expect(response.status()).toBe(201);
  return z.object({ task: z.object({ id: z.string() }) }).parse(await response.json()).task;
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await page.locator('[data-reference-panel]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, name), animations: 'disabled' });
}
for (const width of [390, 1280]) {
  test.describe(`関連資料 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });
    test('メモ下書き保持、保存、編集、削除とURL取得状態', async ({ page, request }) => {
      const value = await task(request);
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await expect(panel.getByRole('tab', { name: 'ファイル', exact: true })).toHaveAttribute('aria-selected', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      for (const tab of await panel.getByRole('tab').all()) expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
      await expect(panel.getByText('メモはまだありません。')).toBeVisible();
      await panel.getByLabel('メモの題名（任意）').fill('確認事項');
      await panel.getByLabel('メモの本文').fill('日本語の関連資料。結論の根拠として参照する。');
      await capture(page, `${width}-note-input.png`);
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      await expect(panel.getByText('URLはまだありません。')).toBeVisible();
      await panel.getByRole('tab', { name: 'URL', exact: true }).press('ArrowLeft');
      await expect(panel.getByRole('tab', { name: 'メモ', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(panel.getByRole('tab', { name: 'URL', exact: true })).toHaveAttribute('aria-selected', 'false');
      await expect(panel.getByRole('tabpanel', { name: 'メモ', exact: true })).toBeVisible();
      await expect(panel.getByLabel('メモの本文')).toHaveValue('日本語の関連資料。結論の根拠として参照する。');
      await capture(page, `${width}-tabs.png`);
      await panel.getByRole('button', { name: 'メモを保存', exact: true }).click();
      const note = panel.locator('[data-reference-kind="NOTE"]');
      await expect(note).toContainText('確認事項');
      await capture(page, `${width}-note-saved.png`);
      await note.getByRole('button', { name: '編集', exact: true }).click();
      await panel.getByLabel('メモの本文').fill('編集した日本語の参考資料');
      await panel.getByRole('button', { name: '変更を保存' }).click();
      await expect(note).toContainText('編集した日本語');
      await capture(page, `${width}-note-edited.png`);
      page.once('dialog', dialog => dialog.accept());
      await note.getByRole('button', { name: '削除', exact: true }).click();
      await expect(note).toHaveCount(0);
      await capture(page, `${width}-note-deleted.png`);
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      await panel.getByLabel('関連するURL').fill('http://example.com/success');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      const successfulUrl = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByRole('link', { name: 'http://example.com/success', exact: true }) });
      await expect(successfulUrl).toContainText('取得済み');
      await expect(panel).toContainText('テスト用データ');
      await panel.getByText('本文を確認', { exact: true }).click();
      await expect(panel).toContainText('fixtureの参考本文');
      await capture(page, `${width}-url-success.png`);
      await panel.getByLabel('関連するURL').fill('http://example.com/failed');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      const failedUrl = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByRole('link', { name: 'http://example.com/failed', exact: true }) });
      await expect(failedUrl).toContainText('取得失敗');
      await expect(failedUrl.getByRole('button', { name: '再取得', exact: true })).toBeVisible();
      await capture(page, `${width}-url-failed.png`);
      await panel.getByLabel('関連するURL').fill('http://127.0.0.1/');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      const loopbackUrl = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByRole('link', { name: 'http://127.0.0.1/', exact: true }) });
      await expect(loopbackUrl).toContainText('安全上の理由');
      await panel.getByLabel('関連するURL').fill('http://private.example.com/');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      const privateUrl = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByRole('link', { name: 'http://private.example.com/', exact: true }) });
      await expect(privateUrl).toHaveCount(1);
      await expect(privateUrl).toContainText('取得失敗');
      await expect(privateUrl).toContainText('安全上の理由');
      await page.reload();
      await page.locator('[data-reference-panel]').getByRole('tab', { name: 'メモ', exact: true }).click();
      await expect(page.getByText('メモはまだありません。')).toBeVisible();
    });
    test('資料の遅延と一覧取得失敗はタスク表示を妨げず再試行できる', async ({ page, request }) => {
      const value = await task(request);
      let fail = true;
      await page.route('**/api/tasks/*/references', async route => {
        await new Promise(resolve => setTimeout(resolve, 700));
        if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        else await route.continue();
      });
      await page.goto(`/tasks/${value.id}`);
      await expect(page.getByRole('heading', { name: '関連資料の合成タスク' })).toBeVisible();
      await expect(page.locator('[data-reference-panel]').getByText('資料を読み込み中…')).toBeVisible();
      await expect(page.locator('[data-ref-error]')).toContainText('資料を読み込めませんでした');
      fail = false;
      await page.getByRole('button', { name: '資料を再読み込み' }).click();
      await expect(page.locator('[data-ref-error]')).toHaveCount(0);
    });
  });
}
test('未ログインでは関連資料APIと画面へアクセスできない', async ({ page, context, request }) => {
  const value = await task(request);
  await context.clearCookies();
  expect((await page.request.get(`/api/tasks/${value.id}/references`)).status()).toBe(401);
  await page.goto(`/tasks/${value.id}`);
  await expect(page).toHaveURL(/\/login/);
});

test('未認証では全資料APIを拒否し、ログイン後もOrigin不一致を拒否する', async ({ request, browser, baseURL }) => {
  const value = await task(request);
  const path = `/api/tasks/${value.id}/references`;
  const origin = new URL(baseURL ?? 'http://127.0.0.1:3350').origin;
  const saved = await request.post(path, { headers: { origin, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, data: { kind: 'NOTE', body: '合成メモ' } });
  expect(saved.status()).toBe(201);
  const reference = z.object({ reference: z.object({ id: z.string() }) }).parse(await saved.json()).reference;
  const anonymous = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    expect((await anonymous.cookies()).length).toBe(0);
    const headers = { origin, 'content-type': 'application/json' };
    expect((await anonymous.request.get(path)).status()).toBe(401);
    expect((await anonymous.request.post(path, { headers, data: { kind: 'NOTE', body: '未認証メモ' } })).status()).toBe(401);
    expect((await anonymous.request.patch(`${path}/${reference.id}`, { headers, data: { body: '変更', revision: 1 } })).status()).toBe(401);
    expect((await anonymous.request.delete(`${path}/${reference.id}`, { headers })).status()).toBe(401);
    expect((await anonymous.request.post(`${path}/${reference.id}/refetch`, { headers })).status()).toBe(401);
  } finally { await anonymous.close(); }
  const invalid = { origin: 'https://invalid.example', 'content-type': 'application/json' };
  expect((await request.post(path, { headers: invalid, data: { kind: 'NOTE', body: '拒否される変更' } })).status()).toBe(403);
  expect((await request.patch(`${path}/${reference.id}`, { headers: invalid, data: { body: '拒否される変更', revision: 1 } })).status()).toBe(403);
  expect((await request.delete(`${path}/${reference.id}`, { headers: invalid })).status()).toBe(403);
  expect((await request.post(`${path}/${reference.id}/refetch`, { headers: invalid })).status()).toBe(403);
});

test('URLの再取得と外部タイトルはテキスト表示、二重送信を防止', async ({ page, request }) => {
  const value = await task(request);
  let item: Extract<Reference, { kind: 'URL' }> = {
    id: 'synthetic-url', taskId: value.id, kind: 'URL', title: '<img src=x onerror="window.referenceInjected=true">', body: '',
    revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), url: 'http://example.com/failed',
    finalUrl: null, fetchStatus: 'FAILED', fetchErrorCode: 'HTTP_ERROR', fetchMode: 'fixture', fetchedAt: null, contentType: null, truncated: false,
  };
  await page.route('**/api/tasks/*/references', route => route.request().method() === 'GET'
    ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ references: [item], limits: {} }) }) : route.continue());
  await page.route('**/api/tasks/*/references/*/refetch', async route => {
    await new Promise(resolve => setTimeout(resolve, 700));
    item = { ...item, fetchStatus: 'SUCCEEDED', fetchErrorCode: null, title: '再取得した参考資料', body: '再取得の参考本文' };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reference: { ...item, fetchErrorCode: null } }) });
  });
  await page.goto(`/tasks/${value.id}`);
  const panel = page.locator('[data-reference-panel]');
  await panel.getByRole('tab', { name: 'URL', exact: true }).click();
  await expect(panel).toContainText('<img src=x onerror=');
  await expect(panel.locator('img')).toHaveCount(0);
  await panel.getByRole('button', { name: '再取得', exact: true }).click();
  await expect(panel.getByRole('button', { name: '再取得', exact: true })).toBeDisabled();
  await expect(panel).toContainText('取得済み');
  await expect(panel).toContainText('再取得した参考資料');
});

const referenceListSchema = z.object({ references: z.array(referenceSchema) });
for (const kind of ['NOTE', 'URL'] as const) {
  for (const changeAndRestore of [false, true]) {
    test(`${kind}は保存応答喪失後${changeAndRestore ? '内容を変更して戻すと新操作になる' : '同内容の再試行で一件に収束する'}`, async ({ page, request }) => {
      const value = await task(request);
      const endpoint = `/api/tasks/${value.id}/references`;
      const keys: string[] = [];
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const key = route.request().headers()['idempotency-key'];
        expect(key).toBeTruthy();
        keys.push(key);
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        if (keys.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: kind === 'NOTE' ? 'メモ' : 'URL', exact: true }).click();
      const input = panel.getByLabel(kind === 'NOTE' ? 'メモの本文' : '関連するURL');
      const original = kind === 'NOTE' ? '保存応答を失った合成メモ' : 'http://example.com/success';
      const changed = kind === 'NOTE' ? '変更された合成メモ' : 'http://example.com/failed';
      await input.fill(original);
      const save = panel.getByRole('button', { name: kind === 'NOTE' ? 'メモを保存' : 'URLを追加', exact: true });
      await save.click();
      await expect(panel.locator('[data-ref-error]')).toContainText('資料を保存できませんでした');
      await expect(input).toHaveValue(original);
      const first = referenceListSchema.parse(await (await request.get(endpoint)).json()).references;
      expect(first).toHaveLength(1);
      if (changeAndRestore) {
        await input.fill(changed);
        await input.fill(original);
      }
      await save.click();
      await expect(panel.locator('[data-ref-error]')).toHaveCount(0);
      await expect(panel.locator(`[data-reference-kind="${kind}"]`)).toHaveCount(changeAndRestore ? 2 : 1);
      expect(keys).toHaveLength(2);
      if (changeAndRestore) expect(keys[1]).not.toBe(keys[0]);
      else expect(keys[1]).toBe(keys[0]);
      const stored = referenceListSchema.parse(await (await request.get(endpoint)).json()).references;
      expect(stored).toHaveLength(changeAndRestore ? 2 : 1);
      if (!changeAndRestore) expect(stored[0].id).toBe(first[0].id);
    });
  }
}

test('メモ保存と一覧503の後も再読み込みからURL取得状態を監視する', async ({ page, request }) => {
  const value = await task(request);
  const endpoint = `/api/tasks/${value.id}/references`;
  const now = new Date().toISOString();
  const item: Extract<Reference, { kind: 'URL' }> = {
    id: 'polling-url', taskId: value.id, kind: 'URL', title: '監視するURL', body: '', revision: 1,
    createdAt: now, updatedAt: now, url: 'http://example.com/success', finalUrl: null,
    fetchStatus: 'FETCHING', fetchErrorCode: null, fetchMode: 'fixture', fetchedAt: null, contentType: null, truncated: false,
  };
  let saved = false;
  let failNext = false;
  let ready = false;
  let successfulReadsAfterSave = 0;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      saved = true;
      return route.fulfill({ response });
    }
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }
    const response = await route.fetch();
    const data = referenceListSchema.parse(await response.json());
    if (saved && ++successfulReadsAfterSave === 1) failNext = true;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ references: [...data.references, ready ? { ...item, fetchStatus: 'SUCCEEDED', title: '監視で取得完了したURL', body: '監視で得た本文' } : item] }) });
  });
  await page.goto(`/tasks/${value.id}`);
  const panel = page.locator('[data-reference-panel]');
  await panel.getByRole('tab', { name: 'URL', exact: true }).click();
  await expect(panel.locator('.reference-status')).toContainText('取得中');
  await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
  await panel.getByLabel('メモの本文').fill('URL監視中に保存するメモ');
  await panel.getByRole('button', { name: 'メモを保存', exact: true }).click();
  await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('URL監視中に保存するメモ');
  await expect(panel.locator('[data-ref-error]')).toContainText('資料を読み込めませんでした', { timeout: 8_000 });
  await panel.getByRole('button', { name: '資料を再読み込み', exact: true }).click();
  await expect(panel.locator('[data-ref-error]')).toHaveCount(0);
  await panel.getByRole('tab', { name: 'URL', exact: true }).click();
  await expect(panel.locator('.reference-status')).toContainText('取得中');
  ready = true;
  await expect(panel.locator('.reference-status')).toContainText('取得済み', { timeout: 8_000 });
  await expect(panel).toContainText('監視で取得完了したURL');
});

test('保存前に開始した古い一覧応答は保存済みメモを消さない', async ({ page, request }) => {
  const value = await task(request);
  const endpoint = `/api/tasks/${value.id}/references`;
  const now = new Date().toISOString();
  const fetching: Extract<Reference, { kind: 'URL' }> = {
    id: 'stale-url', taskId: value.id, kind: 'URL', title: '取得中の合成URL', body: '', revision: 1,
    createdAt: now, updatedAt: now, url: 'http://example.com/success', finalUrl: null,
    fetchStatus: 'FETCHING', fetchErrorCode: null, fetchMode: 'fixture', fetchedAt: null, contentType: null, truncated: false,
  };
  let holdNextResponse = false;
  let oldResponseHeld = false;
  let releaseOldResponse = false;
  let nextPollStarted = false;
  let releaseNextPoll = false;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (holdNextResponse && !oldResponseHeld) {
      oldResponseHeld = true;
      await expect.poll(() => releaseOldResponse, { message: '保存完了後に古い一覧応答が解放される', timeout: 8_000 }).toBe(true);
      return route.fulfill({ json: { references: [fetching] } });
    }
    if (!oldResponseHeld) return route.fulfill({ json: { references: [fetching] } });
    if (releaseOldResponse) {
      nextPollStarted = true;
      await expect.poll(() => releaseNextPoll, { message: '旧応答処理後のメモ確認が終わってから次の一覧を返す', timeout: 8_000 }).toBe(true);
    }
    const response = await route.fetch({ timeout: 5_000 });
    const data = referenceListSchema.parse(await response.json());
    return route.fulfill({ json: { references: [...data.references, { ...fetching, fetchStatus: releaseOldResponse ? 'SUCCEEDED' : 'FETCHING', title: '新しい一覧のURL' }] } });
  });
  try {
    const panel = page.locator('[data-reference-panel]');
    await test.step('初期読込の完了とメモ保存が可能な状態を確認する', async () => {
      await page.goto(`/tasks/${value.id}`, { timeout: 8_000 });
      await expect(panel.getByRole('status').filter({ hasText: '資料を読み込み中' })).toHaveCount(0, { timeout: 8_000 });
      await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
      await panel.getByLabel('メモの本文').fill('古い一覧で消えてはいけないメモ');
      await expect(panel.getByRole('button', { name: 'メモを保存', exact: true })).toBeEnabled({ timeout: 8_000 });
    }, { timeout: 10_000 });
    await test.step('初期読込後の監視による古い一覧応答を保留する', async () => {
      holdNextResponse = true;
      await expect.poll(() => oldResponseHeld, { message: '初期読込後の監視GETが保留される', timeout: 8_000 }).toBe(true);
    }, { timeout: 10_000 });
    await test.step('メモを保存し最新の一覧で保存完了を確認する', async () => {
      await panel.getByRole('button', { name: 'メモを保存', exact: true }).click({ timeout: 8_000 });
      await expect(panel.getByRole('status').filter({ hasText: 'メモを保存しました' })).toBeVisible({ timeout: 8_000 });
      await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('古い一覧で消えてはいけないメモ');
    }, { timeout: 10_000 });
    await test.step('古い応答を処理した後も次の応答を待つ間に保存内容が残る', async () => {
      releaseOldResponse = true;
      await expect.poll(() => nextPollStarted, { message: '古い一覧の処理を終えた監視が次のGETを開始する', timeout: 8_000 }).toBe(true);
      await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('古い一覧で消えてはいけないメモ');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      await expect(panel.locator('[data-reference-kind="URL"] h3')).toHaveText('新しい一覧のURL');
      await expect(panel.locator('.reference-status')).toContainText('取得中');
    }, { timeout: 10_000 });
    await test.step('最新の取得結果と保存済みメモを確認する', async () => {
      releaseNextPoll = true;
      await expect(panel.locator('.reference-status')).toContainText('取得済み', { timeout: 8_000 });
      await expect(panel.locator('[data-reference-kind="URL"] h3')).toHaveText('新しい一覧のURL');
      await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
      await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText('古い一覧で消えてはいけないメモ');
    }, { timeout: 10_000 });
  } finally { releaseOldResponse = true; releaseNextPoll = true; }
});

for (const width of [390, 1280]) {
  test(`長い日本語とURLも資料タブ内で折り返す ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    const value = await task(request);
    const now = new Date().toISOString();
    const common = { taskId: value.id, revision: 1, createdAt: now, updatedAt: now };
    const references: Reference[] = [
      { ...common, id: 'long-note', kind: 'NOTE', title: '長い日本語の題名'.repeat(20), body: '長い参考本文'.repeat(500) },
      { ...common, id: 'long-url', kind: 'URL', title: '長い外部資料の題名'.repeat(25), body: '取得した長い本文'.repeat(500),
        url: `http://example.com/${'a'.repeat(1800)}`, finalUrl: null, fetchStatus: 'SUCCEEDED', fetchErrorCode: null,
        fetchMode: 'fixture', fetchedAt: now, contentType: 'text/plain', truncated: false },
    ];
    await page.route(`**/api/tasks/${value.id}/references`, route => route.fulfill({ json: { references } }));
    await page.goto(`/tasks/${value.id}`);
    const panel = page.locator('[data-reference-panel]');
    for (const tab of ['ファイル', 'メモ', 'URL']) {
      await panel.getByRole('tab', { name: tab, exact: true }).click();
      if (tab === 'メモ') await expect(panel.locator('[data-reference-kind="NOTE"]')).toContainText(references[0].title);
      if (tab === 'URL') await expect(panel.locator('[data-reference-kind="URL"]')).toContainText(references[1].title);
      if (tab === 'URL') await panel.getByText('本文を確認', { exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await expect(panel.locator('.reference-status')).toContainText('取得済み');
    await expect(panel.getByText(/Required/)).toHaveCount(0);
    await expect(panel.getByRole('tabpanel', { name: 'URL', exact: true }).getByText(/必須/)).toBeVisible();
    await expect(panel.getByLabel('関連するURL')).toHaveAttribute('aria-required', 'true');
  });
}
