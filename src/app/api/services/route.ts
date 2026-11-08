import { NextResponse } from 'next/server';
import { aiMode, workerStatusStore } from '../../../adapters/runtime';
import { describeWorker } from '../../../adapters/worker-status';

export const dynamic = 'force-dynamic';

const services = ['Notion', 'Google Drive', 'Gmail', 'Google Calendar', '音声文字起こし', 'AI', '通知'];

/** AIの実行モードはWebの環境変数ではなく、ワーカーがDBに記録した値（heartbeat付き）から返す。 */
export function GET() {
  const worker = describeWorker(workerStatusStore.read());
  return NextResponse.json({
    services: services.map((name) => name === 'AI'
      ? {
        name, mode: worker.mode ?? 'unknown', label: worker.label,
        connection_status: worker.mode === 'cli' ? 'subscription_cli' : worker.mode === 'mock' ? 'mock' : 'unknown',
        // 修正版はWebプロセスが作るため、初版（ワーカー）とは別にWeb側のモードを返す。
        revision: { mode: aiMode, label: aiMode === 'cli' ? 'AI生成（失敗時はモック）' : 'モック' },
        worker: { state: worker.state, mode: worker.mode, lastMode: worker.lastMode, heartbeatAt: worker.heartbeatAt },
      }
      : { name, mode: 'mock', connection_status: 'mock', label: 'モック' }),
  });
}
