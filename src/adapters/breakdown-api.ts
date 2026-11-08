import { z } from 'zod';
import { isValidSessionToken } from '../domain/session';
import { BreakdownError } from '../domain/breakdown';
import type { BreakdownStore } from './breakdown-store';
import type { PreparationStore } from './preparation-store';
import type { TaskStore } from './task-store';

export function breakdownHandlers(stores: { breakdown: BreakdownStore; preparations: PreparationStore; tasks: TaskStore }) {
  return async (request: Request, taskId: string): Promise<Response> => {
    const mode = process.env.AUTH_MODE ?? 'firebase';
    const session = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('task-planner-session='))?.slice('task-planner-session='.length);
    if (!['test', 'firebase'].includes(mode) || (mode === 'test' && process.env.NODE_ENV === 'production') || !isValidSessionToken(session, process.env.SESSION_SECRET, process.env.ALLOWED_EMAILS ?? '')) {
      return Response.json({ error: 'ログインが必要です。' }, { status: 401 });
    }
    if (!z.string().uuid().safeParse(taskId).success || !stores.tasks.get(taskId)) return Response.json({ error: 'タスクが見つかりません。' }, { status: 404 });
    try {
      const origin = request.headers.get('origin');
      const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim() ?? new URL(request.url).host;
      if (request.method !== 'GET' && (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && new URL(origin).host !== host))) return Response.json({ error: 'この送信元は許可されていません。' }, { status: 403 });
      stores.breakdown.syncArtifacts(taskId, stores.preparations);
      if (request.method === 'GET') return Response.json(stores.breakdown.snapshot(taskId), { headers: { 'cache-control': 'no-store' } });
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return Response.json({ error: 'JSON形式で指定してください。' }, { status: 422 });
      const body = await request.text();
      if (Buffer.byteLength(body) > 256_000) return Response.json({ error: '入力が長すぎます。' }, { status: 422 });
      const raw: unknown = JSON.parse(body);
      const result = stores.breakdown.mutate(taskId, raw);
      return Response.json(result, { status: z.object({ action: z.string() }).parse(raw).action === 'regenerate' ? 202 : 200 });
    } catch (error) {
      if (error instanceof BreakdownError) return Response.json({ error: error.code === 'CONFLICT' ? '別の変更があります。編集中の内容を控え、最新の版を確認してください。' : error.code === 'NOT_FOUND' ? '対象が見つかりません。' : '完了・中止したタスクは変更できません。', code: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 409 });
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) return Response.json({ error: '入力形式・項目数・文字数を確認してください。' }, { status: 422 });
      return Response.json({ error: '分解の処理に失敗しました。' }, { status: 500 });
    }
  };
}
