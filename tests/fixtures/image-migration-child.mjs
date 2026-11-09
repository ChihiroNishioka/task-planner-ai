import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const require = createRequire(import.meta.url);
require.extensions['.ts'] = (module, path) => module._compile(ts.transpile(readFileSync(path, 'utf8'), {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}), path);
const { ImageProposalStore } = require('../../src/adapters/image-proposal-store.ts');
const store = new ImageProposalStore(process.argv[2], process.argv[3]);
store.close();
