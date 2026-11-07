import { NextResponse } from 'next/server';

const services = ['Notion', 'Google Drive', 'Gmail', 'Google Calendar', '音声文字起こし', 'AI', '通知'];

export function GET() {
  return NextResponse.json({
    services: services.map((name) => ({ name, mode: 'mock', connection_status: 'mock', label: 'モック' })),
  });
}
