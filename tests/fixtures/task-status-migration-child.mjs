import { TaskStore } from '../../src/adapters/task-store.ts';
process.send('ready');
process.once('message', message => {
  if (message !== 'go') process.exit(2);
  process.send('starting');
  const tasks = new TaskStore(process.argv[2]);
  tasks.close();
  process.disconnect();
});
