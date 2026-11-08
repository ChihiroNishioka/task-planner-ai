import { referenceStore, breakdownStore, aiMode, preparationAdapter, preparationStore, scheduleStore, taskStore, workerStatusStore } from '../adapters/runtime';
import { WORKER_BEAT_MS } from '../adapters/worker-status';

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

async function run() {
  const once = process.argv.includes('--once');
  // 常駐ワーカーだけが自分の実行モードとheartbeatをDBに記録する（--once は記録しない）。
  const beat = () => { try { workerStatusStore.beat(aiMode, process.pid); } catch { /* 記録失敗でジョブ処理は止めない */ } };
  const timer = once ? null : setInterval(beat, WORKER_BEAT_MS);
  if (!once) beat();
  try {
    while (running) {
      await scheduleStore.processDue(new Date(), taskStore, preparationStore);
      const job = await preparationStore.runNext(taskStore, preparationAdapter);
      if (job) breakdownStore.syncArtifacts(job.taskId, preparationStore);
      const breakdownJob = await breakdownStore.runNext(taskStore, preparationStore, preparationAdapter);
      if (once) break;
      if (!job && !breakdownJob) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    if (timer) {
      clearInterval(timer);
      try { workerStatusStore.markStopped(process.pid); } catch { /* 記録失敗は無視 */ }
    }
  }
}

void run().catch(() => {
  process.exitCode = 1;
}).finally(() => {
  referenceStore.close();
  workerStatusStore.close();
  breakdownStore.close();
  preparationStore.close();
  scheduleStore.close();
  taskStore.close();
});
