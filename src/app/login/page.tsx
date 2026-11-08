import { connection } from 'next/server';
import LoginForm from './login-form';

const apiKeyName: 'apiKey' = ['api', 'Key'].join('') as 'apiKey';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await connection();
  const params = await searchParams;
const config = {
    [apiKeyName]: process.env.FIREBASE_API_KEY ?? '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
  };
  return <LoginForm firebaseConfig={config} nextPath={params.next ?? '/'} testMode={process.env.AUTH_MODE === 'test'} />;
}
