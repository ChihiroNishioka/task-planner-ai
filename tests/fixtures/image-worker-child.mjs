import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const require=createRequire(import.meta.url);
require.extensions['.ts']=(module,path)=>module._compile(ts.transpile(readFileSync(path,'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}),path);
require('../../src/worker/index.ts');
