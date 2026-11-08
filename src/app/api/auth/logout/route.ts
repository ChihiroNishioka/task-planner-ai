import { validateCsrfRequest } from '../../../../lib/auth';

export async function POST(request: Request) {
  if (!validateCsrfRequest(request)) return Response.json({ error: 'リクエストを確認できませんでした。' }, { status: 403 });
  const secure = process.env.NODE_ENV === 'production' || request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  return new Response(JSON.stringify({ authenticated: false }), { headers: { 'content-type': 'application/json', 'set-cookie': `task-planner-session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}` } });
}
