import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { breakdownSnapshotSchema } from '../src/domain/breakdown';
import { buildWorkerEnv, unsafeWebAiEnv } from './helpers/safe-ai-env';

const unsafe = unsafeWebAiEnv(process.env, process.cwd());
if (unsafe) throw new Error(unsafe);
function requiredDirectory(name: 'E2E_DATA_DIR' | 'SHOT_DIR', root: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}を明示してください。`);
  const path = resolve(value);
  const child = relative(root, path);
  if (child === '..' || child.startsWith(`..${sep}`) || child.startsWith(sep)) throw new Error(`${name}は${root}内に限定してください。`);
  mkdirSync(path, { recursive: true });
  return path;
}
const dataDirectory = requiredDirectory('E2E_DATA_DIR', '/workspace/dev/tp-mid-data');
const shots = requiredDirectory('SHOT_DIR', '/workspace/dev/tp-mid-runs');
const api = (id: string) => `/api/tasks/${id}/breakdown`;
const generated = '偽CLIが生成した新版を確認する';
const completion = 'AIが新しい分解版を作成しました。';
const editorOf = (page: Page) => page.getByRole('region', { name: '分解編集', exact: true });
const firstOf = (editor: Locator) => editor.getByLabel('項目 1', { exact: true });
const commentOf = (editor: Locator) => editor.getByLabel('全体コメント', { exact: true });
async function read(request: APIRequestContext, id: string) {
  const response = await request.get(api(id));
  expect(response.status()).toBe(200);
  return breakdownSnapshotSchema.parse(await response.json());
}
async function seed(request: APIRequestContext) {
  const created = await request.post('/api/tasks', { data: { title: '架空のmid回帰・テスト認証と偽CLI', category: 'STUDY' } });
  expect(created.status()).toBe(201);
  const { task } = z.object({ task: z.object({ id: z.string().uuid() }) }).parse(await created.json());
  expect((await request.post(api(task.id), { data: { action: 'save', baseVersion: null, requestKey: randomUUID(), steps: ['旧版を読む'] } })).status()).toBe(200);
  return { id: task.id, initial: await read(request, task.id) };
}
async function enqueue(page: Page) {
  const editor = editorOf(page);
  await firstOf(editor).fill('生成依頼時の未保存入力');
  await commentOf(editor).fill('生成依頼時のコメント');
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/breakdown'));
  await editor.getByRole('button', { name: 'このコメントでAIに作り直してもらう', exact: true }).click();
  expect((await accepted).status()).toBe(202);
  await expect(editor.getByText('AIが分解を作成中… ワーカーの処理を待っています。', { exact: true })).toBeVisible();
}
function gatedWorker() {
  const gate = mkdtempSync(join(dataDirectory, 'mid-gate-'));
  const child = spawn('timeout', ['--foreground', '30s', process.execPath, 'node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts', '--once'], {
    env: { NODE_ENV: 'test', ...buildWorkerEnv({
      PATH: process.env.PATH, DATABASE_PATH: process.env.DATABASE_PATH,
      BLOB_DIRECTORY: process.env.BLOB_DIRECTORY, ARTIFACT_DIRECTORY: process.env.ARTIFACT_DIRECTORY,
    }, {
      AI_MODE: 'cli', AI_CLI_PATH: join(process.cwd(), 'tests/fixtures/fake-breakdown-mids-cli.mjs'),
      AI_TIMEOUT_MS: '25000', E2E_DATA_DIR: dataDirectory, FAKE_BREAKDOWN_GATE: gate,
    }, process.cwd()) }, stdio: 'ignore',
  });
  const finished = new Promise<number | null>(resolveExit => {
    child.once('error', () => resolveExit(-1));
    child.once('exit', code => resolveExit(code));
  });
  return {
    started: async () => { await expect.poll(() => existsSync(join(gate, 'started')), { timeout: 15_000 }).toBe(true); },
    release: () => { writeFileSync(join(gate, 'release'), '偽CLIを解放'); },
    finish: async () => { expect(await finished).toBe(0); },
  };
}
async function save(page: Page) {
  const response = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith('/breakdown'));
  await editorOf(page).getByRole('button', { name: 'ユーザー編集版を保存', exact: true }).click();
  return (await response).status();
}
async function capture(page: Page, name: string, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const heights = await editorOf(page).getByRole('button').evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().height > 0).map(button => button.getBoundingClientRect().height));
  expect(heights.every(height => height >= 44)).toBe(true);
  await page.screenshot({ path: join(shots, `${name}-${width}.png`), fullPage: true });
}
async function adoptComparison(page: Page, request: APIRequestContext, id: string) {
  const editor = editorOf(page);
  const before = await read(request, id);
  const mutations: string[] = [];
  const observe = (req: import('@playwright/test').Request) => {
    if (req.method() === 'POST' && req.url().endsWith(api(id))) mutations.push(req.postData() ?? '');
  };
  page.on('request', observe);
  try {
    await editor.getByRole('button', { name: '現在の入力を最新の版に載せ替える', exact: true }).click();
    expect(mutations).toEqual([]);
    expect((await read(request, id)).versions).toEqual(before.versions);
  } finally { page.off('request', observe); }
}

for (const width of [390, 1280]) {
  test(`MID1/MID1-RACE 生成中編集の409から比較と明示載せ替えで保存する・偽CLI ${width}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    const { id, initial } = await seed(request);
    await page.goto(`/tasks/${id}`);
    const editor = editorOf(page);
    await enqueue(page);
    const worker = gatedWorker();
    try {
      await worker.started();
      await firstOf(editor).fill('生成中に変更した入力を残す');
      await commentOf(editor).fill('生成中に変更したコメントを残す');
    } finally { worker.release(); await worker.finish(); }
    expect(await save(page)).toBe(409);
    await expect(firstOf(editor)).toHaveValue('生成中に変更した入力を残す');
    await expect(commentOf(editor)).toHaveValue('生成中に変更したコメントを残す');
    await expect(editor.locator('[data-app-error="true"]')).toContainText(/別の変更|競合/);
    const comparison = editor.getByRole('region', { name: '最新の分解との比較', exact: true });
    await expect(comparison).toContainText(generated);
    await expect(comparison).toContainText('v2');
    await expect(comparison).toBeFocused();
    expect((await read(request, id)).versions).toHaveLength(2);
    await capture(page, 'conflict', width);
    await adoptComparison(page, request, id);
    const compared = await read(request, id);
    expect((await request.post(api(id), { data: { action: 'save', baseVersion: compared.versions.at(-1)!.id, requestKey: randomUUID(), steps: ['比較の後に別タブで保存した新版'] } })).status()).toBe(200);
    expect(await save(page)).toBe(409);
    await expect(firstOf(editor)).toHaveValue('生成中に変更した入力を残す');
    await expect(commentOf(editor)).toHaveValue('生成中に変更したコメントを残す');
    await expect(comparison).toContainText('比較の後に別タブで保存した新版');
    expect((await read(request, id)).versions).toHaveLength(3);
    await adoptComparison(page, request, id);
    expect(await save(page)).toBe(200);
    await expect(editor.getByText('ユーザー編集版を保存しました。', { exact: true })).toBeVisible();
    const result = await read(request, id);
    expect(result.versions).toHaveLength(4);
    expect(result.versions[0]).toEqual(initial.versions[0]);
    expect(result.versions.at(-1)?.steps).toEqual(['生成中に変更した入力を残す']);
    await page.reload();
    await expect(firstOf(editor)).toHaveValue('生成中に変更した入力を残す');
  });

  for (const reload of ['ページ再読込', '最新読込'] as const) {
    for (const state of ['QUEUED', 'RUNNING'] as const) {
      test(`MID2 ${reload}で${state}を再追跡し成功を反映する・偽CLI ${width}`, async ({ page, request }) => {
        await page.setViewportSize({ width, height: 844 });
        const { id } = await seed(request);
        await page.goto(`/tasks/${id}`);
        const editor = editorOf(page);
        await enqueue(page);
        const worker = state === 'RUNNING' ? gatedWorker() : null;
        let queuedWorker: ReturnType<typeof gatedWorker> | null = null;
        try {
          if (worker) await worker.started();
          expect((await read(request, id)).jobs[0]?.status).toBe(state);
          if (reload === 'ページ再読込') {
            page.once('dialog', dialog => dialog.accept());
            await page.reload();
          } else {
            page.once('dialog', dialog => dialog.accept());
            await editor.getByRole('button', { name: '最新の版を読み込む', exact: true }).click();
          }
          await expect(firstOf(editor)).toHaveValue('生成依頼時の未保存入力');
          await expect(commentOf(editor)).toHaveValue('生成依頼時のコメント');
          if (!worker) { queuedWorker = gatedWorker(); await queuedWorker.started(); }
        } finally {
          worker?.release(); queuedWorker?.release();
          if (worker) await worker.finish();
          if (queuedWorker) await queuedWorker.finish();
        }
        await expect(firstOf(editor)).toHaveValue(generated);
        await expect(editor.getByRole('status').filter({ hasText: completion })).toBeVisible();
        await expect(editor.getByText('AIが分解を作成中… ワーカーの処理を待っています。', { exact: true })).toHaveCount(0);
        expect((await read(request, id)).jobs[0]?.status).toBe('SUCCEEDED');
        await capture(page, reload === 'ページ再読込' && state === 'RUNNING' ? 'reload-result' : `reload-${reload}-${state}`, width);
      });
    }

    test(`MID2 ${reload}再追跡後の編集は成功時も保持して載せ替えできる・偽CLI ${width}`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 844 });
      const { id } = await seed(request);
      await page.goto(`/tasks/${id}`);
      const editor = editorOf(page);
      await enqueue(page);
      const worker = gatedWorker();
      try {
        await worker.started();
        if (reload === 'ページ再読込') { page.once('dialog', dialog => dialog.accept()); await page.reload(); }
        else { page.once('dialog', dialog => dialog.accept()); await editor.getByRole('button', { name: '最新の版を読み込む', exact: true }).click(); }
        await expect(firstOf(editor)).toHaveValue('生成依頼時の未保存入力');
        await firstOf(editor).fill('再追跡後の入力を保持する');
        await commentOf(editor).fill('再追跡後のコメントを保持する');
      } finally { worker.release(); await worker.finish(); }
      await expect(editor.getByRole('status').filter({ hasText: completion })).toBeVisible();
      await expect(firstOf(editor)).toHaveValue('再追跡後の入力を保持する');
      await expect(commentOf(editor)).toHaveValue('再追跡後のコメントを保持する');
      await expect(editor.getByRole('region', { name: '最新の分解との比較', exact: true })).toContainText(generated);
      await adoptComparison(page, request, id);
      expect(await save(page)).toBe(200);
      expect((await read(request, id)).versions.at(-1)?.steps).toEqual(['再追跡後の入力を保持する']);
    });
  }

  for (const state of ['QUEUED', 'RUNNING'] as const) {
    test(`MID3 ${state}を画面から取り消し遅い偽CLI結果を破棄して再生成できる ${width}`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 844 });
      const { id, initial } = await seed(request);
      await page.goto(`/tasks/${id}`);
      const editor = editorOf(page);
      await enqueue(page);
      const worker = state === 'RUNNING' ? gatedWorker() : null;
      try {
        if (worker) await worker.started();
        expect((await read(request, id)).jobs[0]?.status).toBe(state);
        const cancelled = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(api(id)));
        await editor.getByRole('button', { name: 'AIの作り直しを取り消す', exact: true }).click();
        expect((await cancelled).status()).toBe(200);
        await expect(editor.getByText('AIの作り直しを取り消しました。', { exact: true })).toBeVisible();
        await expect(firstOf(editor)).toHaveValue('生成依頼時の未保存入力');
        await expect(commentOf(editor)).toHaveValue('生成依頼時のコメント');
        await expect(editor.getByRole('button', { name: 'このコメントでAIに作り直してもらう', exact: true })).toBeEnabled();
        if (state === 'RUNNING') await capture(page, 'cancelled', width);
      } finally { if (worker) { worker.release(); await worker.finish(); } }
      const cancelled = await read(request, id);
      expect(cancelled.versions).toEqual(initial.versions);
      expect(cancelled.jobs[0]?.status).toBe('CANCELLED');
      await enqueue(page);
      const retry = gatedWorker();
      try { await retry.started(); } finally { retry.release(); await retry.finish(); }
      await expect(firstOf(editor)).toHaveValue(generated);
      const result = await read(request, id);
      expect(result.versions).toHaveLength(2);
      expect(result.versions[0]).toEqual(initial.versions[0]);
      expect(result.jobs.map(job => job.status).sort()).toEqual(['CANCELLED', 'SUCCEEDED']);
    });
  }
}

test('MID2 監視GETの通信失敗後も最新読込で実ジョブの追跡を再開する・偽CLI', async ({ page, request }) => {
  const { id } = await seed(request);
  await page.goto(`/tasks/${id}`);
  await enqueue(page);
  const editor = editorOf(page);
  const worker = gatedWorker();
  try {
    await worker.started();
    await page.route(`**${api(id)}`, route => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
    await expect(editor.locator('[data-app-error="true"]')).toContainText('AIの状態を取得できません');
    await expect(firstOf(editor)).toHaveValue('生成依頼時の未保存入力');
    await page.unroute(`**${api(id)}`);
    page.once('dialog', dialog => dialog.accept());
    await editor.getByRole('button', { name: '最新の版を読み込む', exact: true }).click();
    await expect(firstOf(editor)).toHaveValue('生成依頼時の未保存入力');
  } finally { worker.release(); await worker.finish(); }
  await expect(firstOf(editor)).toHaveValue(generated);
  await expect(editor.getByRole('status').filter({ hasText: completion })).toBeVisible();
});

test('ClaudeM2 取消入力は再読込後も一覧から確認付きで最新基準へ回収できる', async ({ page, request }) => {
  const { id } = await seed(request);
  await page.goto(`/tasks/${id}`);
  await enqueue(page);
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'AIの作り直しを取り消す', exact: true }).click();
  await expect(editor.getByText('AIの作り直しを取り消しました。', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(firstOf(editor)).toHaveValue('旧版を読む');
  const latest = await read(request, id);
  expect((await request.post(api(id), { data: { action: 'save', baseVersion: latest.versions.at(-1)!.id, requestKey: randomUUID(), steps: ['別タブの最新版'] } })).status()).toBe(200);
  await editor.getByRole('button', { name: '最新の版を読み込む', exact: true }).click();
  await expect(firstOf(editor)).toHaveValue('別タブの最新版');
  await firstOf(editor).fill('破棄確認前の入力');
  await editor.getByText('取り消した再生成の入力（1件）', { exact: true }).click();
  const recover = editor.getByRole('button', { name: '取消入力1を編集に戻す', exact: true });
  page.once('dialog', dialog => dialog.dismiss());
  await recover.click();
  await expect(firstOf(editor)).toHaveValue('破棄確認前の入力');
  page.once('dialog', dialog => dialog.accept());
  await recover.click();
  await expect(firstOf(editor)).toHaveValue('生成依頼時の未保存入力');
  await expect(commentOf(editor)).toHaveValue('生成依頼時のコメント');
  expect(await save(page)).toBe(200);
  expect((await read(request, id)).versions.at(-1)?.steps).toEqual(['生成依頼時の未保存入力']);
});

for (const source of ['監視GET', '取消応答'] as const) {
  test(`Codexmid ${source}のJ2へ追跡を引き継ぎ切替前の編集も成功時に保持する・偽CLI`, async ({ page, request }) => {
    const { id } = await seed(request);
    await page.goto(`/tasks/${id}`);
    await enqueue(page);
    const editor = editorOf(page);
    await firstOf(editor).fill('J2追跡前からあるローカル編集');
    await commentOf(editor).fill('J2に置き換えられないコメント');
    const j1 = (await read(request, id)).jobs[0]!;
    const startNext = async () => {
      const current = await read(request, id);
      expect((await request.post(api(id), { data: { action: 'regenerate', baseVersion: current.versions.at(-1)!.id, requestKey: randomUUID(), steps: ['別タブのJ2入力'], comment: '別タブのJ2コメント' } })).status()).toBe(202);
    };
    let releasePoll: () => void = () => {};
    const switched = new Promise<void>(resolve => { releasePoll = resolve; });
    await page.route(`**${api(id)}`, async route => {
      if (route.request().method() === 'GET') await switched;
      else if (source === '取消応答') {
        expect((await request.post(api(id), { data: { action: 'cancel', jobId: j1.id, requestKey: randomUUID() } })).status()).toBe(200);
        await startNext();
        releasePoll();
      }
      await route.continue();
    });
    if (source === '監視GET') {
      expect((await request.post(api(id), { data: { action: 'cancel', jobId: j1.id, requestKey: randomUUID() } })).status()).toBe(200);
      await startNext();
      releasePoll();
    } else {
      await editor.getByRole('button', { name: 'AIの作り直しを取り消す', exact: true }).click();
      await expect(editor.getByText('AIの作り直しを取り消しました。', { exact: true })).toBeVisible();
    }
    const j2 = (await read(request, id)).jobs.find(job => job.id !== j1.id)!;
    const observed = await page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(api(id)), { timeout: 10_000 });
    expect(breakdownSnapshotSchema.parse(await observed.json()).jobs.find(job => job.id === j2.id)?.status).toBe('QUEUED');
    await page.unroute(`**${api(id)}`);
    const worker = gatedWorker();
    try { await worker.started(); } finally { worker.release(); await worker.finish(); }
    await expect(editor.getByRole('status').filter({ hasText: completion })).toBeVisible();
    await expect(firstOf(editor)).toHaveValue('J2追跡前からあるローカル編集');
    await expect(commentOf(editor)).toHaveValue('J2に置き換えられないコメント');
    await expect(editor.getByRole('region', { name: '最新の分解との比較', exact: true })).toContainText(generated);
    expect((await read(request, id)).jobs.find(job => job.id === j2.id)?.status).toBe('SUCCEEDED');
  });
}

test('ClaudeM1 成功が先に確定した取消409は状態を再取得し入力保持を説明する・偽CLI', async ({ page, request }) => {
  const { id } = await seed(request);
  await page.goto(`/tasks/${id}`);
  await enqueue(page);
  const editor = editorOf(page);
  await firstOf(editor).fill('取消競合時に保持する入力');
  const worker = gatedWorker();
  try {
    await worker.started();
    await page.route(`**${api(id)}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      worker.release(); await worker.finish();
      await route.continue();
    });
    const rejected = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(api(id)));
    await editor.getByRole('button', { name: 'AIの作り直しを取り消す', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(editor.locator('[data-app-error="true"]')).toContainText('成功済み');
    await expect(editor.locator('[data-app-error="true"]')).not.toContainText('載せ替え');
    await expect(firstOf(editor)).toHaveValue('取消競合時に保持する入力');
    await expect(commentOf(editor)).toHaveValue('生成依頼時のコメント');
    expect((await read(request, id)).jobs[0]?.status).toBe('SUCCEEDED');
  } finally { worker.release(); await worker.finish(); }
});

test('MID2 監視通信の回復で監視エラーだけを解除し入力検証エラーを残す・偽CLI', async ({ page, request }) => {
  const { id } = await seed(request);
  await page.goto(`/tasks/${id}`);
  await enqueue(page);
  const editor = editorOf(page);
  const worker = gatedWorker();
  try {
    await worker.started();
    await page.route(`**${api(id)}`, route => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
    await expect(editor.locator('[data-app-error="true"]')).toContainText('AIの状態を取得できません');
    await firstOf(editor).fill('');
    await editor.getByRole('button', { name: 'ユーザー編集版を保存', exact: true }).click();
    await expect(editor.locator('[data-app-error="true"]')).toContainText('各項目は');
    await page.unroute(`**${api(id)}`);
  } finally { worker.release(); await worker.finish(); }
  await expect(editor.getByRole('status').filter({ hasText: completion })).toBeVisible();
  await expect(editor.locator('[data-app-error="true"]')).not.toContainText('AIの状態を取得できません');
  await expect(editor.locator('[data-app-error="true"]')).toContainText('各項目は');
});

test('ClaudeM1 別画面で完了したタスクの保存409は載せ替えを案内しない', async ({ page, request }) => {
  const { id } = await seed(request);
  await page.goto(`/tasks/${id}`);
  const editor = editorOf(page);
  await firstOf(editor).fill('完了後も保持する未保存入力');
  await commentOf(editor).fill('保持するコメント');
  expect((await request.patch(`/api/tasks/${id}`, { data: { status: 'COMPLETED' } })).status()).toBe(200);
  expect(await save(page)).toBe(409);
  await expect(editor.locator('[data-app-error="true"]')).toContainText('完了・中止');
  await expect(editor.locator('[data-app-error="true"]')).not.toContainText('載せ替え');
  await expect(editor.getByRole('region', { name: '最新の分解との比較', exact: true })).toHaveCount(0);
  await expect(firstOf(editor)).toHaveValue('完了後も保持する未保存入力');
  await expect(commentOf(editor)).toHaveValue('保持するコメント');
});
