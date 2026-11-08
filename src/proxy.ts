import { NextResponse, type NextRequest } from 'next/server';
import { isValidSessionToken } from './domain/session';
import { isSafeNextPath } from './lib/auth';

const publicPaths = new Set(['/login', '/api/auth/session', '/api/auth/logout']);

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path.startsWith('/_next/') || path === '/favicon.ico' || /\.(?:png|jpg|jpeg|svg|ico|css|js|woff2?)$/.test(path)) return NextResponse.next();
  const mode = process.env.AUTH_MODE || 'firebase';
  const authenticated = (mode === 'firebase' || mode === 'test') && !(process.env.NODE_ENV === 'production' && mode === 'test')
    && isValidSessionToken(request.cookies.get('task-planner-session')?.value, process.env.SESSION_SECRET, process.env.ALLOWED_EMAILS ?? '');
  if (path === '/login') return authenticated ? NextResponse.redirect(new URL('/', request.url)) : NextResponse.next();
  if (publicPaths.has(path)) return NextResponse.next();
  if (path.startsWith('/api/')) return authenticated ? NextResponse.next() : NextResponse.json({ error: 'ログインが必要です。' }, { status: 401 });
  if (authenticated) return NextResponse.next();
  const target = new URL('/login', request.url);
  target.searchParams.set('next', isSafeNextPath(`${path}${request.nextUrl.search}`));
  return NextResponse.redirect(target);
}

export const config = { matcher: '/:path*' };
