'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './login.module.css';

export default function AuthStatus({ email }: { email: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  async function logout() {
    setFailed(false);
    const ok = await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((response) => response.ok, () => false);
    if (!ok) { setFailed(true); return; }
    router.replace('/login');
    router.refresh();
  }
  return <header className={styles.authBar}><span className={styles.authEmail} title={email}>ログイン中：{email}</span><button type="button" className={styles.authLogout} onClick={() => void logout()}>ログアウト</button>{failed && <span role="alert" data-app-error="true" className={styles.authError}>ログアウトできませんでした。もう一度押してください。</span>}</header>;
}
