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
      await expect(failedUrl.locator('button[data-reference-action="refetch"]')).toBeVisible();
      await capture(page, `${width}-url-failed.png`);
      await panel.getByLabel('関連するURL').fill('http://127.0.0.1/');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      const loopbackUrl = panel.locator('[data-reference-kind="URL"]').filter({ has: page.locator('span').filter({ hasText: /^http:\/\/127\.0\.0\.1\/$/ }) });
      await expect(loopbackUrl).toContainText('安全上の理由');
      await expect(loopbackUrl.locator('a[href]')).toHaveCount(0);
      await panel.getByLabel('関連するURL').fill('http://private.example.com/');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      const privateUrl = panel.locator('[data-reference-kind="URL"]').filter({ has: page.locator('span').filter({ hasText: /^http:\/\/private\.example\.com\/$/ }) });
      await expect(privateUrl).toHaveCount(1);
      await expect(privateUrl.locator('a[href]')).toHaveCount(0);
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
  await panel.locator('button[data-reference-action="refetch"]').click();
  await expect(panel.locator('button[data-reference-action="refetch"]')).toBeDisabled();
  await expect(panel).toContainText('取得済み');
  await expect(panel).toContainText('再取得した参考資料');
});

const referenceListSchema = z.object({ references: z.array(referenceSchema) });

type UrlReference = Extract<Reference, { kind: 'URL' }>;
function syntheticUrl(taskId: string, changes: Partial<UrlReference> = {}): UrlReference {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), taskId, kind: 'URL', title: '合成の参考ページ', body: '', revision: 1,
    createdAt: now, updatedAt: now, url: 'https://example.com/article', finalUrl: null, fetchStatus: 'FAILED',
    fetchErrorCode: 'HTTP_ERROR', fetchMode: 'fixture', fetchedAt: null, contentType: null, truncated: false, ...changes };
}
const failureCases = [
  ['DNS_FAILED', 'DNS_NOT_FOUND', 'サイトが見つかりませんでした。URLに誤りがないか確認してください。'],
  ['DNS_FAILED', 'DNS_UNAVAILABLE', 'サイトの場所を確認できませんでした。時間をおいて再取得してください。'],
  ['DNS_FAILED', null, 'サイトの場所を確認できませんでした。URLを確認するか、時間をおいて再取得してください。'],
  ['BLOCKED_URL', 'BLOCKED_ADDRESS', '安全上の理由で取得を止めました。公開されていない宛先の可能性があります。公開サイトでも、サーバーの名前解決の設定で止まることがあります。続く場合は管理者に伝えてください。内容が必要なら、メモに貼り付けて追加できます。'],
  ['BLOCKED_URL', 'BLOCKED_URL_FORM', '安全上の理由で取得できない形式のURLです。ポート番号やユーザー名を付けない http / https のURLでお試しください。'],
  ['BLOCKED_URL', null, '安全上の理由で取得できませんでした。再取得しても直らない場合は、内容をメモに貼り付けてください。'],
  ['TIMEOUT', null, '時間内にページを取得できませんでした。時間をおいて再取得してください。'],
  ['HTTP_ERROR', 'HTTP_REFUSED', 'サイトに取得を断られました。時間をおいて再取得するか、内容をメモに貼り付けてください。'],
  ['HTTP_ERROR', 'HTTP_NOT_FOUND', 'ページが見つかりませんでした。URLを確認してください。'],
  ['HTTP_ERROR', 'HTTP_SERVER', 'サイト側でエラーが起きています。時間をおいて再取得してください。'],
  ['HTTP_ERROR', 'HTTP_OTHER', 'ページがエラーを返しました。時間をおいて再取得してください。'],
  ['HTTP_ERROR', null, 'ページがエラーを返しました。時間をおいて再取得してください。'],
  ['NETWORK_ERROR', null, 'ページに接続できませんでした。時間をおいて再取得してください。'],
  ['TOO_MANY_REDIRECTS', null, '転送が多すぎて取得できませんでした。転送先のURLを直接お試しください。'],
  ['UNSUPPORTED_TYPE', null, 'HTML またはテキストのページだけ取り込めます。内容はメモに貼り付けて追加できます。'],
  ['TOO_LARGE', null, 'ページが大きすぎて取り込めません（2MB まで）。必要な部分をメモに貼り付けてください。'],
  ['EMPTY_CONTENT', null, '本文を読み取れませんでした。内容が必要なら、メモに貼り付けて追加できます。'],
  ['DECODE_FAILED', null, '本文を読み取れませんでした。内容が必要なら、メモに貼り付けて追加できます。'],
  ['INTERRUPTED', null, '取得が中断されました。再取得してください。'],
  ['FETCH_DISABLED', null, 'URLの取得は現在オフになっています。内容はメモに貼り付けて追加できます。'],
] satisfies [UrlReference['fetchErrorCode'], UrlReference['fetchFailureReason'], string][];

for (const viewport of [{ width: 390, height: 844, name: 'iphone-390x844' }, { width: 1280, height: 800, name: 'pc-1280x800' }]) {
  test.describe(`URL取り込み改善 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test('UF-E2E-01 UF-E2E-02 UF-E2E-10 UF-E2E-14 UF-E2E-15 全理由・旧コードを安全に表示する', async ({ page, request }) => {
      const value = await task(request);
      const oldCodes = [...new Set(failureCases.map(([code]) => code))];
      const items = [
        ...failureCases.map(([fetchErrorCode, fetchFailureReason], index) => syntheticUrl(value.id, { id: `failure-${index}`, fetchErrorCode, fetchFailureReason,
          url: `https://example.com/${'long-path-'.repeat(120)}${index}` })),
        ...oldCodes.map((fetchErrorCode, index) => syntheticUrl(value.id, { id: `old-${index}`, fetchErrorCode })),
      ];
      await page.route(`**/api/tasks/${value.id}/references`, route => route.fulfill({ json: { references: items } }));
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      const rows = panel.locator('[data-reference-kind="URL"]');
      await expect(rows).toHaveCount(items.length);
      for (const [index, [code, reason, message]] of failureCases.entries()) {
        const row = rows.nth(index);
        const link = row.locator('.reference-url');
        await expect(link).toHaveAttribute('title', items[index].url);
        const geometry = await link.evaluate(element => {
          const style = getComputedStyle(element);
          return { clamp: style.webkitLineClamp, height: element.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), overflow: style.overflow };
        });
        expect(geometry.clamp).toBe('3');
        expect(geometry.overflow).toBe('hidden');
        expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight * 3 + 1);
        const rowBounds = await row.boundingBox();
        const formBounds = await panel.locator('.reference-form').last().boundingBox();
        expect(rowBounds).not.toBeNull(); expect(formBounds).not.toBeNull();
        expect(Math.abs((rowBounds?.x ?? 0) - (formBounds?.x ?? 0))).toBeLessThanOrEqual(1);
        await expect(row.getByRole('button', { name: `${items[index].title || items[index].url}を再取得`, exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: `${items[index].title || items[index].url}を削除`, exact: true })).toBeVisible();
        await expect(row.locator('[data-reference-failure]')).toHaveText(message);
        await expect(row.locator('[data-reference-failure]')).toHaveAttribute('data-reference-failure', reason ?? code ?? '');
        await expect(row.locator('[data-reference-failure]')).not.toHaveAttribute('role');
        if (code === 'BLOCKED_URL') {
          await expect(row.locator('a[href]')).toHaveCount(0);
          await expect(row.locator('span').filter({ hasText: items[index].url })).toHaveCount(1);
        } else await expect(row.getByRole('link')).toHaveAttribute('href', items[index].url);
      }
      for (const [index, code] of oldCodes.entries()) {
        const expected = failureCases.find(([candidate, reason]) => candidate === code && !reason);
        expect(expected).toBeDefined();
        await expect(rows.nth(failureCases.length + index).locator('[data-reference-failure]')).toHaveText(expected?.[2] ?? '');
      }
      expect(await panel.innerText()).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      for (const button of await panel.getByRole('button').all()) expect(await button.evaluate(element => element instanceof HTMLElement ? element.offsetHeight : 0)).toBeGreaterThanOrEqual(44);
      await capture(page, `${viewport.name}-urlfix-failure-messages.png`);
    });

    test('S12 S13 短いURLの理由と資料名付き操作ボタンを画面内に表示する', async ({ page, request }) => {
      const value = await task(request);
      const item = syntheticUrl(value.id, { id: 'failure-short', url: 'https://example.com/a', title: '取得を断られた資料', fetchErrorCode: 'HTTP_ERROR', fetchFailureReason: 'HTTP_REFUSED' });
      await page.route(`**/api/tasks/${value.id}/references`, route => route.fulfill({ json: { references: [item] } }));
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      const row = panel.locator('[data-reference-kind="URL"]');
      await expect(row.getByRole('button', { name: '取得を断られた資料を再取得', exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: '取得を断られた資料を削除', exact: true })).toBeVisible();
      const reason = row.locator('[data-reference-failure]');
      await expect(reason).toHaveText('サイトに取得を断られました。時間をおいて再取得するか、内容をメモに貼り付けてください。');
      await reason.scrollIntoViewIfNeeded();
      await expect(reason).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await row.screenshot({ path: join(shots, `${viewport.name}-urlfix-failure-short.png`), animations: 'disabled' });
    });

    test('UF-E2E-03 UF-E2E-04 UF-E2E-05 UF-E2E-16 fixtureの失敗理由と内部宛先を分ける', async ({ page, request }) => {
      const value = await task(request);
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      const cases = [
        ['http://example.com/forbidden', 'サイトに取得を断られました'], ['http://example.com/gone', 'ページが見つかりませんでした'],
        ['http://example.com/failed', 'サイト側でエラーが起きています'], ['http://example.com/pdf', 'HTML またはテキスト'],
        ['http://example.com/large', 'ページが大きすぎて'], ['http://missing.example.com/', 'サイトが見つかりませんでした'],
        ['http://127.0.0.1/', '安全上の理由'], ['http://private.example.com/', '安全上の理由'], ['http://example.com/private', '安全上の理由'],
        ['http://example.com/rate', 'サイトに取得を断られました'],
      ];
      for (const [url, message] of cases) {
        await panel.getByLabel('関連するURL').fill(url);
        await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
        const row = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByText(url, { exact: true }) });
        await expect(row.locator('[data-reference-failure]')).toContainText(message);
        await expect(row).toContainText('取得失敗');
        if (message === '安全上の理由') await expect(row.locator('a[href]')).toHaveCount(0);
      }
      const privateRow = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByText('http://private.example.com/', { exact: true }) });
      expect(await privateRow.innerText()).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      expect((await panel.innerText()).replace('http://127.0.0.1/', '')).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      await capture(page, `${viewport.name}-urlfix-fixture-failures.png`);
    });

    test('UF-E2E-06 UF-E2E-07 合成の一部取得と取得中の表示を区別する', async ({ page, request }) => {
      const value = await task(request);
      const variants = [
        { truncated: true, contentHint: null, marker: 'TRUNCATED', message: '一部のみ取り込みました（先頭の5万字まで）。続きが必要なら、必要な部分をメモに貼り付けてください。' },
        { truncated: true, contentHint: null, marker: 'PARTIAL', message: '一部のみ取得しました。解析の上限などで本文が欠けています。必要な部分はメモに貼り付けてください。' },
        { truncated: false, contentHint: 'SHORT_BODY', marker: 'SHORT_BODY', message: '一部のみ取得の可能性があります（本文が短いページです）。必要な部分はメモに貼り付けてください。' },
        { truncated: false, contentHint: 'PAYWALL_HINT', marker: 'PAYWALL_HINT', message: '一部のみ取得の可能性があります（ログインや有料の続きがあるページかもしれません）。必要な部分はメモに貼り付けてください。' },
      ] satisfies { truncated: boolean; contentHint: UrlReference['contentHint']; marker: string; message: string }[];
      const items = variants.map(({ truncated, contentHint }, index) => syntheticUrl(value.id, { id: `partial-${index}`, fetchStatus: 'SUCCEEDED', fetchErrorCode: null, body: index === 0 ? '文'.repeat(50000) : '取り込んだ本文', truncated, contentHint }));
      items.push(syntheticUrl(value.id, { id: 'fetching-partial', fetchStatus: 'FETCHING', fetchErrorCode: 'HTTP_ERROR', fetchFailureReason: 'HTTP_REFUSED', body: '以前の本文', truncated: true, contentHint: 'PAYWALL_HINT' }));
      await page.route(`**/api/tasks/${value.id}/references`, route => route.fulfill({ json: { references: items } }));
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      const rows = panel.locator('[data-reference-kind="URL"]');
      for (const [index, variant] of variants.entries()) {
        await expect(rows.nth(index).locator('[data-reference-completeness]')).toHaveText(variant.message);
        await expect(rows.nth(index).locator('[data-reference-completeness]')).toHaveAttribute('data-reference-completeness', variant.marker);
        await expect(rows.nth(index).locator('[data-reference-completeness]')).not.toHaveAttribute('role');
      }
      await expect(rows.nth(variants.length).locator('[data-reference-failure], [data-reference-completeness]')).toHaveCount(0);
      await capture(page, `${viewport.name}-urlfix-partial-messages.png`);
    });

    test('UF-E2E-08 UF-E2E-09 fixtureの一部取得・タイトル・本文を表示する', async ({ page, request }) => {
      const value = await task(request);
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      for (const [path, expected] of [['long', '一部のみ取り込みました（先頭の5万字まで）。続きが必要なら、必要な部分をメモに貼り付けてください。'], ['note-short', '一部のみ取得の可能性']]) {
        const url = `http://example.com/${path}`;
        await panel.getByLabel('関連するURL').fill(url);
        await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
        const row = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByRole('link', { name: url, exact: true }) });
        await expect(row.locator('[data-reference-completeness]')).toContainText(expected);
      }
      for (const [path, title, body] of [['svg-title', '記事の正しいタイトル', '記事の正しい冒頭です。'], ['menu-main', 'メニューを除く記事', '本文の正しい冒頭です。']]) {
        const url = `http://example.com/${path}`;
        await panel.getByLabel('関連するURL').fill(url);
        await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
        const row = panel.locator('[data-reference-kind="URL"]').filter({ has: page.getByRole('link', { name: url, exact: true }) });
        await expect(row.locator('h3')).toHaveText(title);
        await row.getByText('本文を確認', { exact: true }).click();
        await expect(row.locator('.reference-body')).toHaveText(body);
      }
      await capture(page, `${viewport.name}-urlfix-fixture-content.png`);
    });

    for (const fetchStatus of ['FAILED', 'FETCHING'] as const) {
      for (const operation of ['追加', '再取得']) {
        test(`S22 ${operation}の応答が${fetchStatus}でコードなしなら開始通知を残さない`, async ({ page, request }) => {
          const value = await task(request);
          const endpoint = `/api/tasks/${value.id}/references`;
          const saved = syntheticUrl(value.id, { fetchStatus, fetchErrorCode: null });
          let items = operation === '再取得' ? [syntheticUrl(value.id, { fetchStatus: 'FAILED', fetchErrorCode: 'TIMEOUT' })] : [];
          await page.route(`**${endpoint}`, route => {
            if (route.request().method() === 'GET') return route.fulfill({ json: { references: items } });
            items = [saved];
            return route.fulfill({ status: 201, json: { reference: saved } });
          });
          await page.route(`**${endpoint}/*/refetch`, route => {
            items = [saved];
            return route.fulfill({ json: { reference: saved } });
          });
          await page.goto(`/tasks/${value.id}`);
          const panel = page.locator('[data-reference-panel]');
          await panel.getByRole('tab', { name: 'URL', exact: true }).click();
          if (operation === '追加') {
            await panel.getByLabel('関連するURL').fill('https://example.com/article');
            await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
          } else await panel.locator('button[data-reference-action="refetch"]').click();
          await expect(panel.locator('[data-reference-message]')).toHaveAttribute('role', 'status');
          await expect(panel.locator('[data-reference-message]')).toHaveText('結果を確認しています。一覧を確認してください。');
          await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
          await expect(panel.locator('[data-reference-message]')).toHaveText('');
        });
      }
    }

    test('S22 取得中にタブを変えた場合も遅い応答の通知を表示しない', async ({ page, request }) => {
      const value = await task(request);
      const endpoint = `/api/tasks/${value.id}/references`;
      const gate: { release?: () => void } = {};
      const saved = syntheticUrl(value.id, { fetchStatus: 'SUCCEEDED', fetchErrorCode: null, body: '本文' });
      let items: UrlReference[] = [];
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { references: items } });
        await new Promise<void>(resolve => { gate.release = resolve; });
        items = [saved];
        return route.fulfill({ status: 201, json: { reference: saved } });
      });
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      await panel.getByLabel('関連するURL').fill('https://example.com/article');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      await expect(panel.locator('[data-reference-message]')).toHaveText('ページを取得しています。最大20秒ほどかかることがあります。');
      await expect.poll(() => !!gate.release).toBe(true);
      await panel.getByRole('tab', { name: 'メモ', exact: true }).click();
      await expect(panel.locator('[data-reference-message]')).toHaveText('');
      gate.release?.();
      await expect(panel.getByLabel('メモの本文')).toBeEnabled();
      await expect(panel.locator('[data-reference-message]')).toHaveText('');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      await expect(panel.locator('[data-reference-kind="URL"]')).toHaveCount(1);
      await expect(panel.locator('[data-reference-message]')).toHaveText('');
    });

    test('UF-E2E-11 UF-E2E-12 UF-E2E-13 追加・再取得の開始と結果を通知する', async ({ page, request }) => {
      const value = await task(request);
      let items: UrlReference[] = [];
      const gate: { release?: () => void } = {};
      function releaseResponse() { gate.release?.(); gate.release = undefined; }
      let result: 'FAILED' | 'SUCCEEDED' | 'PARTIAL' = 'FAILED';
      const endpoint = `/api/tasks/${value.id}/references`;
      const complete = async () => {
        await new Promise<void>(resolve => { gate.release = resolve; });
        const item = syntheticUrl(value.id, { id: 'notification-url', fetchStatus: result === 'FAILED' ? 'FAILED' : 'SUCCEEDED',
          fetchErrorCode: result === 'FAILED' ? 'HTTP_ERROR' : null, fetchFailureReason: result === 'FAILED' ? 'HTTP_REFUSED' : null,
          body: result === 'FAILED' ? '' : result === 'PARTIAL' ? '文'.repeat(50000) : '取得した本文', truncated: result === 'PARTIAL' });
        items = [item];
        return item;
      };
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { references: items } });
        return route.fulfill({ status: 201, json: { reference: await complete() } });
      });
      await page.route(`**${endpoint}/*/refetch`, async route => route.fulfill({ json: { reference: await complete() } }));
      await page.goto(`/tasks/${value.id}`);
      const panel = page.locator('[data-reference-panel]');
      await panel.getByRole('tab', { name: 'URL', exact: true }).click();
      await panel.getByLabel('関連するURL').fill('https://example.com/article');
      await panel.getByRole('button', { name: 'URLを追加', exact: true }).click();
      const start = panel.getByRole('status').filter({ hasText: 'ページを取得しています。最大20秒ほどかかることがあります。' });
      await expect(start).toBeVisible();
      await expect(panel.getByRole('button', { name: '取得中…', exact: true })).toBeDisabled();
      await expect.poll(() => !!gate.release).toBe(true);
      releaseResponse();
      await expect(panel.getByRole('status').filter({ hasText: 'URLは保存しました。' })).toHaveText('URLは保存しました。サイトに取得を断られました。時間をおいて再取得するか、内容をメモに貼り付けてください。');
      await panel.locator('button[data-reference-action="refetch"]').click();
      await expect(start).toBeVisible();
      await expect.poll(() => !!gate.release).toBe(true);
      releaseResponse();
      await expect(panel.getByRole('status').filter({ hasText: '再取得できませんでした。' })).toHaveText('再取得できませんでした。サイトに取得を断られました。時間をおいて再取得するか、内容をメモに貼り付けてください。');
      await expect(panel.locator('[data-reference-failure]')).toContainText('サイトに取得を断られました');
      result = 'SUCCEEDED';
      await panel.locator('button[data-reference-action="refetch"]').click();
      await expect(start).toBeVisible();
      await expect(panel.locator('button[data-reference-action="refetch"]')).toBeDisabled();
      await expect.poll(() => !!gate.release).toBe(true);
      releaseResponse();
      await expect(panel.getByRole('status').filter({ hasText: /^ページを取り込みました。$/ })).toBeVisible();
      await expect(panel.locator('[data-reference-failure]')).toHaveCount(0);
      result = 'PARTIAL';
      await panel.locator('button[data-reference-action="refetch"]').click();
      await expect(start).toBeVisible();
      await expect.poll(() => !!gate.release).toBe(true);
      releaseResponse();
      await expect(panel.getByRole('status').filter({ hasText: 'ページを取り込みました。一部のみ取り込みました（先頭の5万字まで）。続きが必要なら、必要な部分をメモに貼り付けてください。' })).toBeVisible();
      await capture(page, `${viewport.name}-urlfix-result-notification.png`);
      for (const name of ['メモ', 'ファイル', 'URL']) {
        await panel.getByRole('tab', { name, exact: true }).click();
        await expect(panel.locator('[data-reference-message]')).toHaveText('');
      }
    });
  });
}
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
