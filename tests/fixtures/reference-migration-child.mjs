import { ReferenceStore } from '../../src/adapters/reference-store.ts';

process.send?.('ready');
process.once('message', () => {
  process.send?.('starting');
  const store = new ReferenceStore(process.argv[2]);
  store.close();
  process.disconnect();
});
