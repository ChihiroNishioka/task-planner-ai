import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getSessionEmail } from '../domain/session';
import AuthStatus from './login/auth-status';
import './styles.css';

export const metadata: Metadata = {
  title: 'Task Planner AI',
  description: 'タスクの登録と準備を行う個人用アプリ',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const email = getSessionEmail(cookieStore.get('task-planner-session')?.value, process.env.SESSION_SECRET, process.env.ALLOWED_EMAILS ?? '');
  return <html lang="ja"><body>{email && <AuthStatus email={email} />}{children}</body></html>;
}
