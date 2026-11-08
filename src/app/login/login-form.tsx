'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Auth, GoogleAuthProvider } from 'firebase/auth';
import { isSafeNextPath } from '../../lib/auth-next';
import styles from './login.module.css';

type FirebaseConfig = { apiKey: string; authDomain: string; projectId: string };
type FirebaseAuthModule = typeof import('firebase/auth');
type FirebaseHandle = { auth: Auth; provider: GoogleAuthProvider; authModule: FirebaseAuthModule };

const retryHint = 'もう一度「Googleでログイン」を押してください。';
const genericError = `ログインを完了できませんでした。${retryHint}`;

export default function LoginForm({ firebaseConfig, nextPath, testMode }: { firebaseConfig: FirebaseConfig; nextPath: string; testMode: boolean }) {
  const configured = Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);
  // テストモード以外は、SDK の準備とリダイレクト結果の確認が終わるまで読み込み中にする。
  const [busy, setBusy] = useState(!testMode && configured);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const firebaseRef = useRef<FirebaseHandle | null>(null);
  const router = useRouter();
  const safeNext = isSafeNextPath(nextPath);
  const configurationError = !testMode && !configured ? 'ログインの設定が足りません（管理者向け：FIREBASE_* / SESSION_SECRET / ALLOWED_EMAILS）' : '';

  const sendToken = useCallback(async (token: string, reject: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
      if (!response.ok) {
        await reject().catch(() => undefined);
        const body: unknown = await response.json().catch(() => null);
        const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `サーバーに接続できませんでした。${retryHint}`;
        setError(message);
        setBusy(false);
        return;
      }
      router.replace(safeNext);
      router.refresh();
    } catch {
      setError(`通信エラーが発生しました。${retryHint}`);
      setBusy(false);
    }
  }, [router, safeNext]);

  useEffect(() => {
    if (testMode || !configured) return;
    let active = true;
    void (async () => {
      const [{ getApps, initializeApp }, authModule] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
      const app = getApps()[0] ?? initializeApp(firebaseConfig);
      const auth = authModule.getAuth(app);
      const provider = new authModule.GoogleAuthProvider();
      // 許可外で断られたあと、別のアカウントを選び直せるようにする。
      provider.setCustomParameters({ prompt: 'select_account' });
      firebaseRef.current = { auth, provider, authModule };
      const result = await authModule.getRedirectResult(auth);
      if (!active) return;
      if (result?.user) await sendToken(await result.user.getIdToken(), () => authModule.signOut(auth));
      else setBusy(false);
    })().catch((cause: unknown) => {
      if (!active) return;
      setError(firebaseErrorMessage(cause));
      setBusy(false);
    });
    return () => { active = false; };
  }, [configured, firebaseConfig, sendToken, testMode]);

  function googleLogin() {
    const handle = firebaseRef.current;
    if (!handle) return;
    setBusy(true);
    setError('');
    const { auth, provider, authModule } = handle;
    // iPhone Safari でブロックされないよう、タップの処理の中で await を挟まずにポップアップを開く。
    authModule.signInWithPopup(auth, provider)
      .then(async (result) => sendToken(await result.user.getIdToken(), () => authModule.signOut(auth)))
      .catch(async (cause: unknown) => {
        if (errorCode(cause) === 'auth/popup-blocked') {
          try { await authModule.signInWithRedirect(auth, provider); return; } catch (redirectError) { cause = redirectError; }
        }
        setError(firebaseErrorMessage(cause));
        setBusy(false);
      });
  }

  async function testLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendToken(`test:${email}:verified`, async () => undefined);
  }

  return <main className={styles.page}><section className={styles.card}>
    <h1>Task Planner AI</h1>
    <p>許可されたGoogleアカウントだけ使えます。</p>
    {testMode ? <form className={styles.testForm} onSubmit={(event) => void testLogin(event)}><small>テストモード</small><label htmlFor="test-email">メールアドレス</label><input id="test-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /><button disabled={busy}>{busy ? 'ログインしています…' : 'テストログイン'}</button></form>
      : <button className={styles.google} disabled={busy || !configured} onClick={googleLogin}>{busy ? 'ログインしています…' : 'Googleでログイン'}</button>}
    {(error || configurationError) && <p className={styles.error} role="alert" data-app-error="true">{error || configurationError}</p>}
  </section></main>;
}

function errorCode(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
}

function firebaseErrorMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return `ログイン用の画面が閉じられました。${retryHint}`;
  if (code === 'auth/popup-blocked') return 'ポップアップがブロックされました。Safari の「ポップアップブロック」を一時的にオフにしてから、もう一度お試しください。';
  if (code === 'auth/network-request-failed') return `通信エラーが発生しました。${retryHint}`;
  if (code === 'auth/unauthorized-domain') return 'このURLはログインを許可されていません（管理者向け：Firebase の承認済みドメインを確認）。';
  if (code.startsWith('auth/')) return `Googleログインに失敗しました（${code}）。${retryHint}`;
  return genericError;
}
