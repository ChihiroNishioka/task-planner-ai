import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it,vi} from 'vitest';
import * as imageNormalizer from '../src/adapters/image-normalizer';
import {InputStore} from '../src/adapters/input-store';
import {TaskStore} from '../src/adapters/task-store';
import {GPS_SENTINEL,syntheticJpeg} from './helpers/synthetic-images';
const active=vi.hoisted(()=>({stores:null as {inputStore:InputStore;taskStore:TaskStore}|null}));
vi.mock('../src/adapters/runtime',()=>({get inputStore(){return active.stores!.inputStore;},get taskStore(){return active.stores!.taskStore;}}));
it('A-14 既存の添付POSTもGPS目印を消してJPEGを保存する',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'image-existing-'));const path=join(dir,'db');const inputs=new InputStore(path,join(dir,'blobs'));const tasks=new TaskStore(path);active.stores={inputStore:inputs,taskStore:tasks};vi.stubEnv('BLOB_DIRECTORY',join(dir,'blobs'));
 try{const {POST}=await import('../src/app/api/tasks/[id]/inputs/route');const task=tasks.create({title:'合成画像の添付'});const form=new FormData();const bytes=syntheticJpeg({gps:true});expect(bytes.includes(Buffer.from(GPS_SENTINEL))).toBe(true);form.append('files',new Blob([new Uint8Array(bytes)],{type:'image/jpeg'}),'gps.jpg');const response=await POST(new Request('http://app.example/api/tasks/'+task.id+'/inputs',{method:'POST',body:form,headers:{'idempotency-key':randomUUID()}}),{params:Promise.resolve({id:task.id})});expect(response.status).toBe(201);const saved=inputs.list(task.id)[0];expect(saved.mime).toBe('image/jpeg');expect(readFileSync(saved.path).includes(Buffer.from(GPS_SENTINEL))).toBe(false);
 }finally{inputs.close();tasks.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
});

it('A-14 複数画像は正規化上限2を超えず順序どおり全件保存する', async () => {
 const dir=mkdtempSync(join(tmpdir(),'image-existing-batch-'));const path=join(dir,'db');const inputs=new InputStore(path,join(dir,'blobs'));const tasks=new TaskStore(path);active.stores={inputStore:inputs,taskStore:tasks};
 let running=0;
 const normalize=vi.spyOn(imageNormalizer,'normalizeImage').mockImplementation(async input=>{
  running++;
  try {
   if(running>2)throw new Error('IMAGE_BUSY');
   await new Promise<void>(resolve=>setTimeout(resolve,10));
   return {bytes:input.bytes,name:input.name,sourceFormat:'JPEG',width:2,height:2};
  }finally{running--;}
 });
 try {
  const {POST}=await import('../src/app/api/tasks/[id]/inputs/route');const task=tasks.create({title:'合成画像3枚の添付'});const form=new FormData();
  for(const name of ['first.jpg','second.jpg','third.jpg'])form.append('files',new Blob([new Uint8Array(syntheticJpeg())],{type:'image/jpeg'}),name);
  const response=await POST(new Request('http://app.example/api/tasks/'+task.id+'/inputs',{method:'POST',body:form,headers:{'idempotency-key':randomUUID()}}),{params:Promise.resolve({id:task.id})});
  expect(response.status).toBe(201);
  expect(inputs.list(task.id).map(input=>input.name)).toEqual(['first.jpg','second.jpg','third.jpg']);
  expect(normalize).toHaveBeenCalledTimes(3);
 }finally{normalize.mockRestore();inputs.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
