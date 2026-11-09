import { DraftFlowStore } from '../../src/adapters/draft-flow-store.ts';
process.send?.('ready');
process.once('message', () => {
  const store = new DraftFlowStore(process.argv[2], process.argv[3]);
  store.close();
  process.disconnect();
});
