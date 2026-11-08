'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './login.module.css';

type FirebaseConfig = { apiKey: string; authDomain: string; projectId: string };

export default function LoginForm({ firebaseConfig, nextPath, testMode }: { firebaseConfig: FirebaseConfig; nextPath: string; testMode: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const router = useRouter();
  const safeNext = nextPath.startsWith('/') && !nextPath.startsWith('//') && !nextPath.startsWith('/\\') ? nextPath : '/';
  const configurationError = !testMode && (!firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId) ? 'ログインの設定が足りません（管理者向け：FIREBASE_* / SESSION_SECRET / ALLOWED_EMAILS）' : '';

  const sendToken = useCallback(async (token: string, reject: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
      if (!response.ok) {
        await reject();
        const body: unknown = await response.json();
        const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'ログイン情報を確認できませんでした。もう一度お試しください。';
        throw new Error(message);
      }
      router.replace(safeNext);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '通信エラーが発生しました。もう一度お試しください。');
    } finally { setBusy(false); }
  }, [router, safeNext]);

  useEffect(() => {
    if (testMode) return;
    if (!firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId) return;
    let active = true;
    void import('firebase/app').then(async ({ getApps, initializeApp }) => {
      const app = getApps()[0] ?? initializeApp(firebaseConfig);
      const authModule = await import('firebase/auth');
      const auth = authModule.getAuth(app);
      const result = await authModule.getRedirectResult(auth);
      if (active && result?.user) await sendToken(await result.user.getIdToken(), async () => { await authModule.signOut(auth); });
    }).catch(() => { if (active) setError('ログインを完了できませんでした。もう一度お試しください。'); });
    return () => { active = false; };
  }, [firebaseConfig, sendToken, testMode]);

  async function googleLogin() {
    setBusy(true); setError('');
    try {
      const [{ initializeApp, getApps }, authModule] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
      const app = getApps()[0] ?? initializeApp(firebaseConfig);
      const auth = authModule.getAuth(app);
      const provider = new authModule.GoogleAuthProvider();
      try {
        const result = await authModule.signInWithPopup(auth, provider);
        await sendToken(await result.user.getIdToken(), async () => { await authModule.signOut(auth); });
      } catch (cause) {
        const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
        if (code === 'auth/popup-blocked') { await authModule.signInWithRedirect(auth, provider); return; }
        if (code === 'auth/popup-closed-by-user') throw new Error('ログイン用のポップアップが閉じられました。');
        throw cause;
      }
    } catch (cause) {
      setError(firebaseErrorMessage(cause));
    } finally { setBusy(false); }
  }

  async function testLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendToken(`test:${email}:verified`, async () => undefined);
  }

  return <main className={styles.page}><section className={styles.card}>
    <h1>Task Planner AI</h1>
    <p>許可されたGoogleアカウントだけ使えます。</p>
    {testMode ? <form className={styles.testForm} onSubmit={(event) => void testLogin(event)}><small>テストモード</small><label htmlFor="test-email">メールアドレス</label><input id="test-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /><button disabled={busy}>{busy ? 'ログインしています…' : 'テストログイン'}</button></form>
      : <button className={styles.google} disabled={busy || !firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId} onClick={() => void googleLogin()}>{busy ? 'ログインしています…' : 'Googleでログイン'}</button>}
    {(error || configurationError) && <p className={styles.error} role="alert" data-app-error="true">{error || configurationError}</p>}
  </section></main>;
}

function firebaseErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string') {
    if (cause.code === 'auth/popup-closed-by-user') return 'ログイン用のポップアップが閉じられました。';
    if (cause.code === 'auth/popup-blocked') return 'ポップアップがブロックされました。ブラウザーの設定を確認してください。';
    if (cause.code === 'auth/network-request-failed') return '通信エラーが発生しました。もう一度お試しください。';
  }
  return cause instanceof Error ? cause.message : '通信エラーが発生しました。もう一度お試しください。';
}
