import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const require = createRequire(import.meta.url);
require.extensions['.ts'] = (module, path) => module._compile(ts.transpile(readFileSync(path, 'utf8'), {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}), path);
const { ImageProposalStore } = require('../../src/adapters/image-proposal-store.ts');
const { InputStore } = require('../../src/adapters/input-store.ts');
const { TaskStore } = require('../../src/adapters/task-store.ts');
const tasks = new TaskStore(process.argv[2]);
const inputs = new InputStore(process.argv[2],process.argv[3]);
const store = new ImageProposalStore(process.argv[2],process.argv[3],{tasks,inputs});
try {
 const result=store.createTask(process.argv[4],JSON.parse(process.argv[5]));
 process.stdout.write(JSON.stringify({taskId:result.task.id})+'\n');
} catch(error) {
 if(error.code!=='PROPOSAL_CREATING') throw error;
 process.stdout.write(JSON.stringify({code:error.code})+'\n');
} finally {store.close();inputs.close();tasks.close();}
