import { connection } from 'next/server';
import { isSafeNextPath } from '../../lib/auth-next';
import LoginForm from './login-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  await connection();
  const params = await searchParams;
  const webKey = process.env.FIREBASE_API_KEY ?? '';
  const config = {
    apiKey: webKey,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
  };
  return <LoginForm firebaseConfig={config} nextPath={isSafeNextPath(params.next)} testMode={process.env.AUTH_MODE === 'test'} />;
}
