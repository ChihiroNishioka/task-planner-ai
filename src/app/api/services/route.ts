import { NextResponse } from 'next/server';
import { aiMode } from '../../../adapters/ai-config';

const services = ['Notion', 'Google Drive', 'Gmail', 'Google Calendar', '音声文字起こし', 'AI', '通知'];

export function GET() {
  return NextResponse.json({
    services: services.map((name) => name === 'AI' && aiMode === 'cli'
      ? { name, mode: 'cli', connection_status: 'subscription_cli', label: 'AI生成（サブスクCLI・失敗時はモック）' }
      : { name, mode: 'mock', connection_status: 'mock', label: 'モック' }),
  });
}
