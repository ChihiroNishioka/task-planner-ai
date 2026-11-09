import { TaskStore } from '../../src/adapters/task-store.ts';
import { DraftFlowStore } from '../../src/adapters/draft-flow-store.ts';
import { MockAiAdapter } from '../../src/adapters/mock-ai.ts';
import { DraftFlowError } from '../../src/domain/draft-flow.ts';

const [path, directory, operation, taskId, breakdownVersionId] = process.argv.slice(2);
const go = new Promise(resolve => process.once('message', message => {
  if (message !== 'go') throw new Error('開始合図が不正です。');
  resolve();
}));
const tasks = new TaskStore(path);
const flow = new DraftFlowStore(path, directory);
const mock = new MockAiAdapter();
const ready = () => process.send?.({ kind: 'ready' });
try {
  let result;
  if (operation === 'revise') {
    try {
      const artifact = await flow.reviseDraft(taskId, '読みやすくする', tasks, {
        generate: task => mock.generate(task),
        reviseDraft: async (...args) => {
          const generation = await mock.reviseDraft(...args);
          ready();
          await go;
          return generation;
        },
      });
      result = { kind: 'revised', versionId: artifact.versionId };
    } catch (error) {
      if (!(error instanceof DraftFlowError && error.code === 'DRAFT_JOB_ACTIVE') &&
          !(error instanceof Error && error.message === '改訂中に別の版が作成されたため、修正版を保存しませんでした。最新の版を確認してください。')) throw error;
      result = { kind: 'revision-conflict' };
    }
  } else {
    ready();
    await go;
    if (operation === 'enqueue') {
      const job = flow.enqueue(taskId, breakdownVersionId, 'shared-request');
      result = { kind: 'enqueued', jobId: job.id };
    } else {
      if (operation === 'create') flow.enqueue(taskId, breakdownVersionId, 'worker-create');
      const job = await flow.runNextDraft(tasks, mock);
      result = { kind: 'worked', job };
    }
  }
  process.send?.(result);
} catch {
  process.exitCode = 1;
} finally {
  flow.close();
  tasks.close();
  process.disconnect();
}
