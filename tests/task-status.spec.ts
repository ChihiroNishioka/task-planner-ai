import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { scheduleRecordSchema } from '../src/domain/scheduling';
import { taskListResponseSchema, taskResponseSchema } from '../src/domain/task';
import { requiredDirectory } from './helpers/required-e2e-directory';

const dataDirectory = requiredDirectory('E2E_DATA_DIR', '/workspace/dev/tp-status-data');
const shots = requiredDirectory('SHOT_DIR', '/workspace/dev/tp-status-runs');
const createdSchema = z.object({ task: z.object({ id: z.string().uuid(), title: z.string() }) });
const scheduleSchema = z.object({ schedule: scheduleRecordSchema.nullable() });
const test = base.extend<{ task: z.infer<typeof createdSchema>['task'] }>({
  task: async ({ request }, runTest) => {
    const task = await seed(request);
    try {
      await runTest(task);
    } finally {
      try {
        expect((await request.patch(`/api/tasks/${task.id}`, { data: { status: 'CANCELLED' } })).status()).toBe(200);
      } finally {
        expect((await request.delete(`/api/tasks/${task.id}`)).status()).toBe(204);
      }
      const db = new Database(process.env.DATABASE_PATH ?? join(dataDirectory, 'playwright.sqlite'), { readonly: true, fileMustExist: true });
      try {
        const countSchema = z.object({ count: z.number().int().nonnegative() });
        expect(countSchema.parse(db.prepare('SELECT COUNT(*) AS count FROM preparation_jobs WHERE task_id = ?').get(task.id)).count).toBe(0);
        expect(countSchema.parse(db.prepare("SELECT COUNT(*) AS count FROM task_schedules WHERE task_id = ? AND status = 'SCHEDULED'").get(task.id)).count).toBe(0);
        expect(countSchema.parse(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE task_id = ? AND status = 'SCHEDULED'").get(task.id)).count).toBe(0);
      } finally {
        db.close();
      }
    }
  },
});
const control = (page: Page) => page.getByRole('radiogroup', { name: 'タスクの状態', exact: true });
const submit = (page: Page) => page.getByRole('button', { name: '状態を変更', exact: true });
const message = (page: Page) => page.getByTestId('status-message');
const error = (page: Page) => page.getByTestId('status-error');

async function seed(request: APIRequestContext) {
  const response = await request.post('/api/tasks', { data: { title: `状態変更の架空タスク ${randomUUID()}`, category: 'STUDY' } });
  expect(response.status()).toBe(201);
  return createdSchema.parse(await response.json()).task;
}

async function change(page: Page, label: string) {
  await control(page).getByRole('radio', { name: label, exact: true }).click();
  await submit(page).click();
}

async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('html')).not.toHaveAttribute('data-astryx-theme');
}

async function capture(page: Page, name: string, width: number, fullPage = true) {
  await layout(page);
  await page.screenshot({ path: join(shots, `${name}-${width}.png`), fullPage, animations: 'disabled' });
}

for (const width of [390, 1280]) {
  test.describe(`${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    });

    test('ST-P01 新しい動き 未着手から進行中へ変更して保存とフォーカスを確かめる', async ({ page, task }) => {
      await page.goto(`/tasks/${task.id}`);
      await expect(submit(page)).toBeDisabled();
      const hint = page.getByText('「状態を変更」を押すと保存されます。', { exact: true });
      await expect(hint).toHaveCount(0);
      await control(page).getByRole('radio', { name: '進行中', exact: true }).click();
      await expect(hint).toBeVisible();
      await expect(hint).not.toHaveAttribute('role');
      await control(page).getByRole('radio', { name: '未着手', exact: true }).click();
      await expect(hint).toHaveCount(0);
      await change(page, '進行中');
      await expect(message(page)).toHaveAttribute('role', 'status');
      await expect(message(page)).toHaveText('状態を「進行中」に変更しました。');
      await expect(message(page)).toBeFocused();
      await capture(page, 'status-change', width);
      await page.reload();
      await expect(control(page).getByRole('radio', { name: '進行中', exact: true })).toBeChecked();
      await expect(submit(page)).toBeDisabled();
    });

    test('ST-P02 新しい動き 完了から再開して予定と分解編集を戻す', async ({ page, request, task }) => {
      const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
      expect((await request.post(`/api/tasks/${task.id}/schedule`, { data: { deadline, estimatedAiMinutes: 30, estimatedHumanMinutes: 60 } })).status()).toBe(201);
      await page.goto(`/tasks/${task.id}`);
      await change(page, '完了');
      await expect(message(page)).toContainText('状態を「完了」に変更しました。');
      await expect(page.getByText('完了日時', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: '分解編集', exact: true }).getByRole('button', { name: '項目を追加', exact: true })).toBeDisabled();
      await change(page, '未着手');
      const dialog = page.getByRole('alertdialog', { name: '未着手に戻しますか？', exact: true });
      await expect(dialog).toContainText('完了日時が消えます。締切前の通知が残っていれば、今から届くようにします（通知はモックです）。');
      await expect(dialog).toBeVisible();
      await capture(page, 'status-reopen-confirm', width, false);
      await dialog.getByRole('button', { name: '未着手に戻す', exact: true }).click();
      await expect(message(page)).toContainText('締切前の通知を作り直しました（モック）。');
      await expect(page.getByText('完了日時', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('region', { name: '分解編集', exact: true }).getByRole('button', { name: '項目を追加', exact: true })).toBeEnabled();
      const response = await request.get(`/api/tasks/${task.id}/schedule`);
      expect(response.status()).toBe(200);
      expect(scheduleSchema.parse(await response.json()).schedule).toMatchObject({ revision: 2, status: 'SCHEDULED', deadline });
      await expect(message(page)).toBeFocused();
      await capture(page, 'status-reopen-done', width);
    });

    test('ST-P03 新しい動き 別画面の完了との競合を示し最新状態へ更新する', async ({ page, request, task }) => {
      await page.goto(`/tasks/${task.id}`);
      await expect(control(page).getByRole('radio', { name: '未着手', exact: true })).toBeChecked();
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { status: 'COMPLETED', expectedStatus: 'OPEN' } })).status()).toBe(200);
      await change(page, '進行中');
      await expect(error(page)).toHaveAttribute('role', 'alert');
      await expect(error(page)).toHaveText('別の画面で状態が「完了」に変わりました。内容を確認して、もう一度操作してください。');
      await expect(control(page).getByRole('radio', { name: '完了', exact: true })).toBeChecked();
      await expect(page.locator('.detail-card')).toContainText('完了 / AI');
      await expect(error(page)).toBeFocused();
      await capture(page, 'status-error', width);
    });

    test('ST-P04 新しい動き 保存失敗で選択を保ち再試行できる', async ({ page, task }) => {
      await page.goto(`/tasks/${task.id}`);
      await page.route(`**/api/tasks/${task.id}`, async route => {
        if (route.request().method() === 'PATCH') await route.fulfill({ status: 500, json: { error: '失敗注入' } });
        else await route.continue();
      });
      await change(page, '進行中');
      await expect(error(page)).toHaveText('状態を変更できませんでした。もう一度お試しください。');
      await expect(control(page).getByRole('radio', { name: '進行中', exact: true })).toBeChecked();
      await expect(error(page)).toBeFocused();
      await page.unroute(`**/api/tasks/${task.id}`);
      await submit(page).click();
      await expect(message(page)).toHaveText('状態を「進行中」に変更しました。');
    });

    test('ST-P05 新しい動き 保存中は変更中表示と二重操作防止を備える', async ({ page, task }) => {
      await page.goto(`/tasks/${task.id}`);
      let release = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route(`**/api/tasks/${task.id}`, async route => {
        if (route.request().method() === 'PATCH') await gate;
        await route.continue();
      });
      try {
        await change(page, '進行中');
        await expect(page.getByRole('button', { name: '変更中…', exact: true })).toBeDisabled();
        await expect(control(page).locator('xpath=ancestor::section[1]')).toHaveAttribute('aria-busy', 'true');
        for (const radio of await control(page).getByRole('radio').all()) await expect(radio).toBeDisabled();
      } finally { release(); }
      await expect(message(page)).toHaveText('状態を「進行中」に変更しました。');
    });

    test('ST-P06 新しい動き キーボード選択は保存せず確定と確認取消でフォーカスを管理する', async ({ page, task }) => {
      await page.goto(`/tasks/${task.id}`);
      const radio = control(page).getByRole('radio', { name: '未着手', exact: true });
      await expect(radio).toBeChecked();
      let patches = 0;
      page.on('request', item => { if (item.method() === 'PATCH' && item.url().endsWith(`/api/tasks/${task.id}`)) patches += 1; });
      for (let index = 0; index < 20; index += 1) {
        await page.keyboard.press('Tab');
        if (await radio.evaluate(element => element === document.activeElement)) break;
      }
      await expect(radio).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(control(page).getByRole('radio', { name: '進行中', exact: true })).toBeChecked();
      expect(patches).toBe(0);
      await page.keyboard.press('Tab');
      await expect(submit(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(message(page)).toHaveText('状態を「進行中」に変更しました。');
      await expect(message(page)).toBeFocused();
      expect(patches).toBe(1);
      await page.keyboard.press('Shift+Tab');
      await expect(control(page).getByRole('radio', { name: '進行中', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(control(page).getByRole('radio', { name: '完了', exact: true })).toBeChecked();
      await expect(submit(page)).toBeEnabled();
      await page.keyboard.press('Tab');
      await expect(submit(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(message(page)).toContainText('状態を「完了」に変更しました。');
      await expect(message(page)).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(control(page).getByRole('radio', { name: '完了', exact: true })).toBeFocused();
      await page.keyboard.press('Home');
      await expect(control(page).getByRole('radio', { name: '未着手', exact: true })).toBeChecked();
      await expect(submit(page)).toBeEnabled();
      await page.keyboard.press('Tab');
      await expect(submit(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('alertdialog')).not.toBeVisible();
      await expect(submit(page)).toBeFocused();
      await expect(control(page).getByRole('radio', { name: '未着手', exact: true })).toBeChecked();
      expect(patches).toBe(2);
    });

    test('ST-P07 新しい動き 終了系では準備と期限設定を無効にする', async ({ page, task }) => {
      await page.goto(`/tasks/${task.id}`);
      for (const label of ['完了', '中止']) {
        await change(page, label);
        await expect(message(page)).toContainText(`状態を「${label}」に変更しました。`);
        await expect(page.getByRole('button', { name: 'AI準備を依頼', exact: true })).toBeDisabled();
        await expect(page.getByLabel('締切日時（日本時間）', { exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: '期限と通知を設定', exact: true })).toBeDisabled();
        await expect(page.getByText('完了・中止のタスクは、AI準備と期限の設定ができません。上の「状態」で未着手か進行中に戻すと使えます。', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'AI準備を依頼', exact: true })).toHaveAttribute('aria-describedby', 'closed-task-guidance');
        await expect(page.locator('.schedule-form')).toHaveAttribute('aria-describedby', 'closed-task-guidance closed-schedule-guidance');
        await expect(page.getByLabel('締切日時（日本時間）', { exact: true })).toHaveAttribute('aria-describedby', 'closed-task-guidance closed-schedule-guidance');
        const guidance = page.getByText('完了・中止のため設定できません。', { exact: true });
        await expect(guidance).toBeVisible();
        await expect(page.locator('.schedule-form')).toContainText('完了・中止のため設定できません。');
        await expect(page.getByRole('button', { name: '期限と通知を設定', exact: true })).toHaveAttribute('aria-describedby', 'closed-task-guidance closed-schedule-guidance');
        await expect(page.getByRole('button', { name: '期限と通知を設定', exact: true })).toHaveCSS('opacity', '0.65');
        await expect(page.getByLabel('締切日時（日本時間）', { exact: true })).toHaveCSS('opacity', '0.65');
      }
    });

    test('ST-P08 新しい動き 一覧の中止絞り込みと詳細からの再開を確認する', async ({ page, request, task }) => {
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { status: 'CANCELLED' } })).status()).toBe(200);
      await page.goto('/');
      await page.getByRole('navigation', { name: 'タスクの絞り込み', exact: true }).getByRole('button', { name: '中止', exact: true }).click();
      const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: task.title, exact: true }) });
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: `${task.title}を完了`, exact: true })).toHaveCount(0);
      await card.getByRole('link', { name: task.title, exact: true }).click();
      await change(page, '未着手');
      await page.getByRole('alertdialog').getByRole('button', { name: '未着手に戻す', exact: true }).click();
      await expect(message(page)).toContainText('状態を「未着手」に変更しました。');
      await page.getByRole('link', { name: '← タスク一覧', exact: true }).click();
      await page.getByRole('navigation', { name: 'タスクの絞り込み', exact: true }).getByRole('button', { name: 'すべて', exact: true }).click();
      await expect(page.getByRole('link', { name: task.title, exact: true })).toBeVisible();
    });

    test('ST-P10 一覧の状態変更に失敗しても再取得した一覧を残す', async ({ page, request, task }) => {
      await page.goto('/');
      const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: task.title, exact: true }) });
      await expect(card).toBeVisible();
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { status: 'IN_PROGRESS', expectedStatus: 'OPEN' } })).status()).toBe(200);
      await card.getByRole('button', { name: `${task.title}を完了`, exact: true }).click();
      await expect(page.getByTestId('task-action-error')).toHaveAttribute('role', 'alert');
      await expect(page.getByTestId('task-action-error')).toContainText('別の画面で状態が「進行中」に変わりました。');
      await expect(page.getByTestId('task-action-error')).toBeFocused();
      await expect(page.getByTestId('task-action-error')).toBeInViewport();
      await expect(card).toBeVisible();
      await expect(card).toContainText('進行中');
    });

    test('ST-P14 長い一覧の末尾で500が続いてもエラーへフォーカスし表示範囲へ移す', async ({ page, request, task }) => {
      const response = await request.get('/api/tasks');
      expect(response.status()).toBe(200);
      const current = taskListResponseSchema.parse(await response.json()).tasks.find(item => item.id === task.id);
      expect(current).toBeDefined();
      if (!current) throw new Error('作成したタスクがありません。');
      const preceding = Array.from({ length: 24 }, (_, index) => ({ ...current, id: randomUUID(), title: `一覧表示用の架空タスク ${index + 1}` }));
      await page.route('**/api/tasks', route => route.fulfill({ json: { tasks: [...preceding, current] } }));
      await page.route(`**/api/tasks/${task.id}`, route => route.fulfill({ status: 500, json: { error: '状態を更新できませんでした。' } }));
      await page.goto('/');
      const button = page.getByRole('button', { name: `${task.title}を完了`, exact: true });
      const actionError = page.getByTestId('task-action-error');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await button.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
        await button.click();
        await expect(actionError).toHaveText('状態を更新できませんでした。');
        await expect(actionError).toBeFocused();
        await expect(actionError).toBeInViewport();
        await expect(page.getByRole('article')).toHaveCount(25);
      }
    });

    test('ST-P11 締切なしと期限超過の再開確認は通知の結果だけを示す', async ({ page, request, task }) => {
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { status: 'COMPLETED' } })).status()).toBe(200);
      await page.goto(`/tasks/${task.id}`);
      await change(page, '未着手');
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('完了日時が消えます。');
      await expect(dialog).not.toContainText('通知');
      await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { deadline: '2000-01-01' } })).status()).toBe(200);
      await page.reload();
      await change(page, '未着手');
      await expect(dialog).toContainText('完了日時が消えます。締切を過ぎているため、通知は届きません。');
      await expect(dialog).not.toContainText('AI準備');
    });

    test('ST-P12 消えたタスクには一覧への戻り方を案内する', async ({ page, task }) => {
      await page.goto(`/tasks/${task.id}`);
      await page.route(`**/api/tasks/${task.id}`, async route => {
        if (route.request().method() === 'PATCH') await route.fulfill({ status: 404, json: { code: 'NOT_FOUND', error: 'タスクが見つかりません。' } });
        else await route.continue();
      });
      await change(page, '進行中');
      await expect(error(page)).toHaveText('タスクが見つかりません。削除された可能性があります。「タスク一覧」に戻ってください。');
      await expect(submit(page)).toBeDisabled();
      await expect(page.getByRole('link', { name: '← タスク一覧', exact: true })).toBeVisible();
    });

    test('ST-P13 予定なしの未来締切でも通知とAI準備の開始を断定しない', async ({ page, request, task }) => {
      const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { deadline } })).status()).toBe(200);
      expect((await request.patch(`/api/tasks/${task.id}`, { data: { status: 'COMPLETED' } })).status()).toBe(200);
      await page.route(`**/api/tasks/${task.id}`, async route => {
        if (route.request().method() !== 'GET') { await route.continue(); return; }
        const response = await route.fetch();
        const result = taskResponseSchema.parse(await response.json());
        await route.fulfill({ response, json: { task: { ...result.task, aiPreparationRequired: true } } });
      });
      await page.goto(`/tasks/${task.id}`);
      await change(page, '未着手');
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('完了日時が消えます。締切前の通知が残っていれば、今から届くようにします（通知はモックです）。');
      await expect(dialog).not.toContainText('開始時刻');
      await expect(dialog).not.toContainText('AI準備');
      await dialog.getByRole('button', { name: '未着手に戻す', exact: true }).click();
      await expect(message(page)).toHaveText('状態を「未着手」に変更しました。');
    });

    test('ST-P09 新しい動きと回帰の確認 幅と局所テーマを保ち四つのラベルを表示する', async ({ page, task }) => {
      await page.goto(`/tasks/${task.id}`);
      for (const label of ['未着手', '進行中', '完了', '中止']) await expect(control(page).getByRole('radio', { name: label, exact: true })).toBeVisible();
      const dimensions = await submit(page).evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0 }));
      expect(dimensions.height).toBeGreaterThanOrEqual(44);
      if (width === 390) expect(Math.abs(dimensions.width - dimensions.parentWidth)).toBeLessThanOrEqual(2);
      else expect(await page.locator('.shell').evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(760);
      await change(page, '完了');
      await expect(message(page)).toContainText('状態を「完了」に変更しました。');
      await change(page, '未着手');
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      for (const button of await dialog.getByRole('button').all()) {
        expect(await button.evaluate(element => (element as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
      }
      await layout(page);
    });
  });
}
