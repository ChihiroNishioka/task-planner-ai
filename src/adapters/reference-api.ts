import type { TaskStore } from './task-store';
import type { ReferenceStore } from './reference-store';
import { referenceInputSchema, referenceLimits, ReferenceError, type FetchResult, type Reference } from '../domain/references';
import { isValidSessionToken } from '../domain/session';
import { validateCsrfRequest } from '../lib/auth';

declare global { var __referenceFetchActive: number | undefined; }
type Dependencies = { tasks: Pick<TaskStore, 'get'>; store: ReferenceStore; fetcher: { mode: 'live' | 'fixture'; fetch: (url: string) => Promise<FetchResult> } };
function authenticated(request: Request): boolean {
  const mode = process.env.AUTH_MODE || 'firebase';
  if (!['firebase', 'test'].includes(mode) || (process.env.NODE_ENV === 'production' && mode === 'test')) return false;
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('task-planner-session='))?.slice('task-planner-session='.length);
  return isValidSessionToken(cookie, process.env.SESSION_SECRET, process.env.ALLOWED_EMAILS ?? '');
}
const errorResponse = (error: string, status: number) => Response.json({ error }, { status });

export function createReferenceApi({ tasks, store, fetcher }: Dependencies) {
  return { handle: async (request: Request, taskId: string, refId?: string, action?: 'refetch'): Promise<Response> => {
    if (!authenticated(request)) return errorResponse('ログインが必要です。', 401);
    if (request.method !== 'GET' && !validateCsrfRequest(request)) return errorResponse('操作元を確認できません。', 403);
    if (!tasks.get(taskId)) return errorResponse('タスクが見つかりません。', 404);
    let acquired = false;
    const acquire = () => {
      if ((globalThis.__referenceFetchActive ?? 0) >= 3) throw new ReferenceError(429, '同時に取得できるのは3件までです。');
      globalThis.__referenceFetchActive = (globalThis.__referenceFetchActive ?? 0) + 1; acquired = true;
    };
    const fetchItem = async (item: Reference): Promise<Response> => {
      if (item.kind !== 'URL') throw new ReferenceError(422, 'URLだけ再取得できます。');
      const attempt = store.beginFetch(taskId, item.id, fetcher.mode);
      let result: FetchResult;
      try { result = await fetcher.fetch(item.url); } catch { result = { ok: false, code: 'NETWORK_ERROR' }; }
      if (!authenticated(request) || !tasks.get(taskId)) {
        store.finishFetch(taskId, item.id, attempt, { ok: false, code: 'INTERRUPTED' });
        return errorResponse('ログイン状態またはタスクを確認してください。', authenticated(request) ? 404 : 401);
      }
      store.finishFetch(taskId, item.id, attempt, result);
      return Response.json({ reference: store.require(taskId, item.id) }, { status: refId ? 200 : 201 });
    };
    try {
      if (request.method === 'GET' && !refId) return Response.json({ references: store.list(taskId), limits: referenceLimits });
      if (request.method === 'POST' && !refId) {
        const input = referenceInputSchema.parse(await request.json());
        const key = request.headers.get('idempotency-key') ?? undefined;
        if (key && (key.length > 200 || !/^[\w.-]+$/.test(key))) return errorResponse('操作キーを確認してください。', 422);
        const existed = key ? store.hasOperation(taskId, key) : false;
        if (input.kind === 'URL' && !existed) acquire();
        const item = store.add(taskId, input, key);
        if (input.kind === 'NOTE' || existed) return Response.json({ reference: item }, { status: 201 });
        return await fetchItem(item);
      }
      if (!refId) return errorResponse('操作が見つかりません。', 404);
      if (request.method === 'POST' && action === 'refetch') { const item = store.require(taskId, refId); acquire(); return await fetchItem(item); }
      if (request.method === 'PATCH' && !action) return Response.json({ reference: store.edit(taskId, refId, await request.json()) });
      if (request.method === 'DELETE' && !action) { store.remove(taskId, refId); return new Response(null, { status: 204 }); }
      return errorResponse('操作が見つかりません。', 404);
    } catch (error) {
      return error instanceof ReferenceError ? errorResponse(error.message, error.status) : errorResponse('関連資料の入力を確認してください。', 422);
    } finally {
      if (acquired) globalThis.__referenceFetchActive = Math.max(0, (globalThis.__referenceFetchActive ?? 1) - 1);
    }
  } };
}
