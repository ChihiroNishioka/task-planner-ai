import { createSessionToken } from '../../../../domain/session';
import { validateCsrfRequest, verifyFirebaseIdToken, verifyTestIdToken } from '../../../../lib/auth';

export const runtime = 'nodejs';

const messages = {
  invalid: 'ログイン情報を確認できませんでした。もう一度お試しください。',
  expired: 'ログイン情報を確認できませんでした。もう一度お試しください。',
  unverified: 'メールアドレスが確認されていないGoogleアカウントです。',
  not_allowed: 'このGoogleアカウントでは使えません。許可されたアカウントでログインしてください。',
} as const;

export async function POST(request: Request) {
  if (!validateCsrfRequest(request)) return Response.json({ error: 'リクエストを確認できませんでした。' }, { status: 403 });
  const mode = process.env.AUTH_MODE || 'firebase';
  if (!['firebase', 'test'].includes(mode)) return Response.json({ error: 'ログインの設定が足りません。' }, { status: 503 });
  if (mode === 'test' && process.env.NODE_ENV === 'production') {
    console.error('本番環境でテスト認証モードを拒否しました。');
    return Response.json({ error: 'テスト認証は本番環境で使えません。' }, { status: 503 });
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: 'ログインの設定が足りません（管理者向け：FIREBASE_* / SESSION_SECRET / ALLOWED_EMAILS）' }, { status: 503 });
  if (mode === 'firebase' && !process.env.FIREBASE_PROJECT_ID) return Response.json({ error: 'ログインの設定が足りません（管理者向け：FIREBASE_* / SESSION_SECRET / ALLOWED_EMAILS）' }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: messages.invalid }, { status: 400 }); }
  if (typeof body !== 'object' || body === null || !('idToken' in body) || typeof body.idToken !== 'string' || body.idToken.length > 16_384) return Response.json({ error: messages.invalid }, { status: 400 });
  const allowed = process.env.ALLOWED_EMAILS ?? '';
  const result = mode === 'test'
    ? await verifyTestIdToken(body.idToken, allowed)
    : await verifyFirebaseIdToken(body.idToken, process.env.FIREBASE_PROJECT_ID ?? '', allowed);
  if (!result.ok) return Response.json({ error: messages[result.reason] }, { status: 401 });
  const response = Response.json({ authenticated: true });
  const secure = process.env.NODE_ENV === 'production' || request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  response.headers.append('Set-Cookie', `task-planner-session=${createSessionToken(secret, result.email)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
  return response;
}
