'use client';

import { useRouter } from 'next/navigation';

export default function AuthStatus({ email }: { email: string }) {
  const router = useRouter();
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    router.replace('/login');
    router.refresh();
  }
  return <header style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, padding: '8px 16px' }}><span>ログイン中：{email}</span><button type="button" onClick={() => void logout()} style={{ minHeight: 44 }}>ログアウト</button></header>;
}
