import { mockAiAdapter, preparationStore, taskStore } from '../adapters/runtime';

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

async function run() {
  const once = process.argv.includes('--once');
  while (running) {
    const job = await preparationStore.runNext(taskStore, mockAiAdapter);
    if (once) break;
    if (!job) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

void run().catch(() => {
  process.exitCode = 1;
}).finally(() => {
  preparationStore.close();
  taskStore.close();
});
