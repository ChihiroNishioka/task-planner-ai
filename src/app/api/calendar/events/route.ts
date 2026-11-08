import { NextResponse } from 'next/server';
import { mockCalendarAdapter } from '../../../../adapters/runtime';

export function GET() {
  return NextResponse.json({
    events: mockCalendarAdapter.listEvents(),
    service: { mode: mockCalendarAdapter.mode, connection_status: 'mock', label: mockCalendarAdapter.label },
  });
}
