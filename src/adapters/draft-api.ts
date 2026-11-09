import type { DraftFlowStore } from './draft-flow-store';
import type { TaskStore } from './task-store';
import { z } from 'zod';
import { isValidSessionToken } from '../domain/session';
import { draftCommandSchema, DraftFlowError } from '../domain/draft-flow';

export function draftHandlers(stores: { tasks: TaskStore; drafts: DraftFlowStore }) {
  return async (request: Request, taskId: string): Promise<Response> => {
    const mode = process.env.AUTH_MODE ?? 'firebase';
    const session = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('task-planner-session='))?.slice('task-planner-session='.length);
    if (!['test', 'firebase'].includes(mode) || (mode === 'test' && process.env.NODE_ENV === 'production') || !isValidSessionToken(session, process.env.SESSION_SECRET, process.env.ALLOWED_EMAILS ?? '')) {
      return Response.json({ error: 'ログインが必要です。' }, { status: 401 });
    }
    if (!z.string().uuid().safeParse(taskId).success || !stores.tasks.get(taskId)) return Response.json({ error: 'タスクが見つかりません。' }, { status: 404 });
    try {
      const origin = request.headers.get('origin');
      const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim() ?? new URL(request.url).host;
      if (request.method !== 'GET' && (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && new URL(origin).host !== host))) return Response.json({ error: 'この送信元は許可されていません。' }, { status: 403 });
      if (request.method === 'GET') return Response.json(stores.drafts.snapshot(taskId), { headers: { 'cache-control': 'no-store' } });
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return Response.json({ error: '入力形式を確認してください。' }, { status: 422 });
      const body = await request.text();
      if (Buffer.byteLength(body) > 256_000) return Response.json({ error: '入力形式を確認してください。' }, { status: 422 });
      const command = draftCommandSchema.parse(JSON.parse(body));
      if (command.action === 'create') stores.drafts.enqueue(taskId, command.breakdownVersionId, command.requestKey);
      else stores.drafts.cancel(taskId, command.jobId);
      return Response.json(stores.drafts.snapshot(taskId), { status: command.action === 'create' ? 202 : 200 });
    } catch (error) {
      if (error instanceof DraftFlowError) return Response.json({ error: error.message, code: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : error.code === 'BREAKDOWN_EMPTY' || error.code === 'BREAKDOWN_INVALID' ? 422 : 409 });
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) return Response.json({ error: '入力形式を確認してください。' }, { status: 422 });
      return Response.json({ error: 'ドラフトの処理に失敗しました。' }, { status: 500 });
    }
  };
}
