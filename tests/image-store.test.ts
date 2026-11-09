import { mkdtempSync, rmSync, readdirSync, symlinkSync, writeFileSync, mkdirSync, utimesSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ImageProposalStore, type ImageAnalysis } from '../src/adapters/image-proposal-store';
import { InputStore } from '../src/adapters/input-store';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';
import { WorkerStatusStore, describeWorker } from '../src/adapters/worker-status';

let directory: string;
let now: Date;
let worker: 'running' | 'never' | 'stale' | 'stopped';
let store: ImageProposalStore;
let tasks: TaskStore;
let inputs: InputStore;
const image = { bytes: Buffer.from([255,216,255,217]), name: 'test.jpg', sourceFormat: 'JPEG', width: 2, height: 2 } as const;
const confirmed = { title: '確認したタイトル', deadline: '2027-01-01', description: '説明', note: 'メモ', extractedText: '確認した文章' };
const ai: ImageAnalysis = { mode: 'ai', fallbackReason: null, suggestion: { title: '候補', deadline: null, description: '', extractedText: '抽出した文章', noTaskFound: false } };
function enqueue(key = 'one') { return store.enqueue({ operationKey: key, requestHash: key, originalName: 'test.jpg', note: 'メモ由来の候補', image }).proposal; }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'image-store-')); now = new Date('2026-11-09T00:00:00Z'); worker = 'running';
  tasks = new TaskStore(join(directory, 'db.sqlite')); inputs = new InputStore(join(directory, 'db.sqlite'), join(directory, 'blobs'));
  store = new ImageProposalStore(join(directory, 'db.sqlite'), join(directory, 'blobs'), {now: () => now, workerState: () => worker, tasks, inputs});
});
afterEach(() => { store?.close(); inputs?.close(); tasks?.close(); rmSync(directory, {recursive:true,force:true}); });
it('U-40 取消後のworkerの遅れた結果を捨てる', async () => {
  const proposal = enqueue(); let finish!: (result: ImageAnalysis) => void;
  const running = store.runNext(() => new Promise(resolve => { finish = resolve; }));
  store.cancel(proposal.id); finish(ai); await running; expect(store.get(proposal.id)).toBeNull();
});
it.each(['never','stale','stopped'] as const)('U-41 worker %s の20秒猶予後にメモを維持してfallbackする', (state) => {
  worker = state; const proposal = enqueue(); now = new Date(now.getTime()+19_999); expect(store.get(proposal.id)?.status).toBe('QUEUED');
  now = new Date(now.getTime()+1); expect(store.get(proposal.id)).toMatchObject({status:'READY',mode:'mock_fallback',fallbackReason:'WORKER_UNAVAILABLE', suggestion:{title:'メモ由来の候補'}});
});
it('U-44 heartbeat正常なら300秒後もQUEUEDのまま通常実行できる', async () => {
  const proposal = enqueue(); now = new Date(now.getTime()+301_000);
  expect(store.get(proposal.id)).toMatchObject({status:'QUEUED',queueDelayed:true,mode:null});
  await store.runNext(async () => ai); expect(store.get(proposal.id)?.status).toBe('READY');
});
it('U-45 RUNNING lease切れを回収し遅れた結果を捨てる', async () => {
  const proposal = enqueue(); let finish!: (result: ImageAnalysis) => void;
  const running = store.runNext(() => new Promise(resolve => {finish=resolve;}));
  const db = new Database(join(directory,'db.sqlite'));
  expect(db.prepare('SELECT lease_until FROM image_proposals WHERE id=?').get(proposal.id)).toEqual({lease_until:'2026-11-09T00:02:30.000Z'}); db.close();
  now = new Date(now.getTime()+150_001); expect(store.get(proposal.id)?.fallbackReason).toBe('WORKER_UNAVAILABLE');
  finish(ai); await running; expect(store.get(proposal.id)?.mode).toBe('mock_fallback');
});
it('U-49 同じ確定入力は同じtask、違う確定入力は拒否する', async () => {
  const proposal = enqueue(); await store.runNext(async()=>ai);
  const first = store.createTask(proposal.id,confirmed); const second = store.createTask(proposal.id,confirmed);
  expect(second.task.id).toBe(first.task.id); expect(inputs.list(first.task.id)).toHaveLength(1);
  expect(inputs.list(first.task.id)[0]).toMatchObject({analysisStatus:'EXTRACTED',extractedText:'確認した文章'});
  expect(() => store.createTask(proposal.id,{...confirmed,title:'別の内容'})).toThrow('PROPOSAL_ALREADY_CONFIRMED');
  expect(readdirSync(join(directory,'blobs')).filter(name=>name.endsWith('.blob'))).toEqual([`${proposal.id}.blob`]);
});
it('U-29 mock_fallbackでは送信された抽出本文を保存しない', async () => {
  const proposal=enqueue(); await store.runNext(async()=>({...ai,mode:'mock_fallback',fallbackReason:'CLI_EXIT'}));
  const result=store.createTask(proposal.id,confirmed); expect(inputs.list(result.task.id)[0]).toMatchObject({analysisStatus:'NOT_PROCESSED'});
  expect(inputs.list(result.task.id)[0]?.extractedText).toBeUndefined();
});
it('U-19 提案と添付の不正なblob名と外部へのsymlinkを拒否する', async()=>{
 const proposal=enqueue(); const db=new Database(join(directory,'db.sqlite'));
 for(const name of ['../x','/tmp/x','a/b','bad\0name','','invalid.jpg']) {db.prepare('UPDATE image_proposals SET blob_name=? WHERE id=?').run(name,proposal.id);expect(store.readImage(proposal.id)).toBeNull();}
 db.prepare('UPDATE image_proposals SET blob_name=? WHERE id=?').run(`${proposal.id}.jpg`,proposal.id);
 const external=join(directory,'outside');writeFileSync(external,'SECRET-SYNTHETIC');
 rmSync(join(directory,'blobs','proposals',`${proposal.id}.jpg`));symlinkSync(external,join(directory,'blobs','proposals',`${proposal.id}.jpg`));expect(store.readImage(proposal.id)).toBeNull();
 const saved=inputs.addProposalImage('task',proposal.id,image);
 for(const name of ['../x','/tmp/x','a/b','bad\0name','','invalid.blob']) {db.prepare('UPDATE task_inputs SET blob_name=? WHERE id=?').run(name,saved.id);expect(inputs.readImage('task',saved.id)).toBeNull();}
 db.prepare('UPDATE task_inputs SET blob_name=? WHERE id=?').run(`${proposal.id}.blob`,saved.id);
 rmSync(join(directory,'blobs',`${proposal.id}.blob`));symlinkSync(external,join(directory,'blobs',`${proposal.id}.blob`));expect(inputs.readImage('task',saved.id)).toBeNull();
 db.close();
});
it('U-42 期限切れ提案の行と画像を削除する',()=>{const proposal=enqueue();now=new Date(now.getTime()+86_400_001);store.cleanup();expect(store.get(proposal.id)).toBeNull();expect(readdirSync(join(directory,'blobs','proposals'))).toEqual([]);});

it.each(['admitted','task','blob','input','analysis','consumed','imageDeleted'])('U-43 %s 後の障害でも同じタスクと添付に復旧する',async(stage)=>{
 const proposal=enqueue();await store.runNext(async()=>ai);store.close();let failed=false;
 store=new ImageProposalStore(join(directory,'db.sqlite'),join(directory,'blobs'),{now:()=>now,workerState:()=>worker,tasks,inputs,onCreateStage:current=>{if(current===stage&&!failed){failed=true;throw new Error(`FAULT_${stage}`);}}});
 expect(()=>store.createTask(proposal.id,confirmed)).toThrow(`FAULT_${stage}`);
 expect(store.createTask(proposal.id,confirmed).task.title).toBe(confirmed.title);
 expect(readdirSync(join(directory,'blobs','proposals'))).toEqual([]);
 expect(tasks.list()).toHaveLength(1);expect(inputs.list(tasks.list()[0]!.id)).toHaveLength(1);
 expect(readdirSync(join(directory,'blobs')).filter(name=>name.endsWith('.blob'))).toEqual([`${proposal.id}.blob`]);
 const db=new Database(join(directory,'db.sqlite'));expect(db.prepare('SELECT count(*) AS count FROM task_input_analyses').get()).toEqual({count:1});db.close();
});
it('U-48 同じ提案を2プロセスで作成してもタスク添付blobが1つ',async()=>{
 now=new Date();
 const proposal=enqueue();await store.runNext(async()=>ai);
 const run=()=>new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['tests/fixtures/image-create-child.mjs',join(directory,'db.sqlite'),join(directory,'blobs'),proposal.id,JSON.stringify(confirmed)],{stdio:'pipe',timeout:10000});child.on('error',reject);child.on('exit',resolve);});
 expect(await Promise.all([run(),run()])).toEqual([0,0]);expect(tasks.list()).toHaveLength(1);
 expect(inputs.list(tasks.list()[0]!.id)).toHaveLength(1);expect(readdirSync(join(directory,'blobs')).filter(name=>name.endsWith('.blob'))).toEqual([`${proposal.id}.blob`]);
});

it.each([{timeout:undefined,lease:150000},{timeout:0,lease:31000},{timeout:999999,lease:630000}])('U-45 timeout $timeout は上下限へ丸めてleaseへ30秒加算する',async({timeout,lease})=>{
 store.close();store=new ImageProposalStore(join(directory,'db.sqlite'),join(directory,'blobs'),{now:()=>now,workerState:()=>worker,aiTimeoutMs:timeout});
 const proposal=enqueue();let finish!:(result:ImageAnalysis)=>void;const running=store.runNext(()=>new Promise(resolve=>{finish=resolve;}));
 const db=new Database(join(directory,'db.sqlite'));expect(db.prepare('SELECT lease_until FROM image_proposals WHERE id=?').get(proposal.id)).toEqual({lease_until:new Date(now.getTime()+lease).toISOString()});db.close();
 now=new Date(now.getTime()+lease-1);expect(store.get(proposal.id)?.status).toBe('RUNNING');finish(ai);await running;
});
it('U-42 cleanupは古いtmpと孤児画像を削除し現役画像を維持する',()=>{
 const proposal=enqueue();const old=new Date(now.getTime()-3600001);const temporary=join(directory,'blobs','tmp');mkdirSync(temporary);
 const oldTemp=join(temporary,'old');mkdirSync(oldTemp);writeFileSync(join(oldTemp,'input'),'synthetic');utimesSync(oldTemp,old,old);
 const newTemp=join(temporary,'new');mkdirSync(newTemp);utimesSync(newTemp,now,now);
 const orphan='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg';writeFileSync(join(directory,'blobs','proposals',orphan),'synthetic');utimesSync(join(directory,'blobs','proposals',orphan),old,old);
 const active=join(directory,'blobs','proposals',`${proposal.id}.jpg`);utimesSync(active,old,old);
 store.cleanup();expect(readdirSync(temporary)).toEqual(['new']);expect(readdirSync(join(directory,'blobs','proposals'))).toEqual([`${proposal.id}.jpg`]);
});

it('U-46 分解CLIが混雑してもheartbeatが続けば画像はQUEUEDで待機しゲート解放後にAI完了する',async()=>{
 const databasePath=join(directory,'db.sqlite');const blobs=join(directory,'blobs');const gate=join(directory,'gate');
 const preparations=new PreparationStore(databasePath,join(directory,'artifacts'));const workerStatus=new WorkerStatusStore(databasePath);
 const task=tasks.create({title:`IMAGE_TEST_GATE:${gate}`,aiPreparationRequired:true});preparations.enqueue(task,'gate');
 const cli=join(directory,'fake-cli');copyFileSync('tests/fixtures/fake-image-gate-cli.mjs',cli);chmodSync(cli,0o700);
 store.close();store=new ImageProposalStore(databasePath,blobs,{workerState:()=>describeWorker(workerStatus.read()).state,workerGraceMs:1000,queueNoticeMs:1000,tasks,inputs});
 const child=spawn(process.execPath,['tests/fixtures/image-worker-child.mjs'],{env:{...process.env,AI_MODE:'cli',AI_CLI:'claude',AI_CLI_PATH:cli,DATABASE_PATH:databasePath,BLOB_DIRECTORY:blobs,ARTIFACT_DIRECTORY:join(directory,'artifacts'),IMAGE_QUEUE_NOTICE_MS:'1000',IMAGE_WORKER_GRACE_MS:'1000'},stdio:'pipe',timeout:25000});
 let childError:Error|undefined;child.on('error',error=>{childError=error;});
 const waitFor=async(predicate:()=>boolean)=>{const end=Date.now()+10000;while(!predicate()){if(childError)throw childError;if(Date.now()>end)throw new Error('WORKER_GATE_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,25));}};
 try{
  await waitFor(()=>existsSync(`${gate}.started`));const first=workerStatus.read()?.heartbeatAt;const proposal=enqueue();
  await waitFor(()=>workerStatus.read()?.heartbeatAt!==first);
  expect(store.get(proposal.id)).toMatchObject({status:'QUEUED',queueDelayed:true,mode:null});
  writeFileSync(`${gate}.release`,'release');await waitFor(()=>store.get(proposal.id)?.status==='READY');expect(store.get(proposal.id)?.mode).toBe('ai');
 }finally{child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else{child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},2000).unref();}});workerStatus.close();preparations.close();}
},30000);
it('U-49 CREATINGでも別内容を拒否し、最初の確認値でGET復旧する',async()=>{
 const proposal=enqueue();await store.runNext(async()=>ai);store.close();let failed=false;
 store=new ImageProposalStore(join(directory,'db.sqlite'),join(directory,'blobs'),{now:()=>now,workerState:()=>worker,tasks,inputs,onCreateStage:stage=>{if(stage==='task'&&!failed){failed=true;throw new Error('FAULT_TASK');}}});
 expect(()=>store.createTask(proposal.id,confirmed)).toThrow('FAULT_TASK');expect(()=>store.createTask(proposal.id,{...confirmed,title:'違う確認値'})).toThrow('PROPOSAL_ALREADY_CONFIRMED');expect(store.get(proposal.id)?.status).toBe('CONSUMED');expect(tasks.list()[0].title).toBe(confirmed.title);
});
it('U-41 別接続の回収も同じ結果になり試行tokenを消す',()=>{
 worker='stopped';const proposal=enqueue();now=new Date(now.getTime()+20000);const other=new ImageProposalStore(join(directory,'db.sqlite'),join(directory,'blobs'),{now:()=>now,workerState:()=>worker});
 try{const one=store.get(proposal.id);expect(other.get(proposal.id)).toEqual(one);const db=new Database(join(directory,'db.sqlite'));expect(db.prepare('SELECT attempt_token FROM image_proposals WHERE id=?').get(proposal.id)).toEqual({attempt_token:null});db.close();}finally{other.close();}
});
it('U-42 使用済み7日と期限切れRUNNING/READYを掃除しCREATINGを保護して復旧する',async()=>{
 const consumed=enqueue('consumed');await store.runNext(async()=>ai);store.createTask(consumed.id,confirmed);
 const ready=enqueue('ready');await store.runNext(async()=>ai);const running=enqueue('running');const creating=enqueue('creating');await store.runNext(async()=>ai);await store.runNext(async()=>ai);
 const db=new Database(join(directory,'db.sqlite'));db.prepare("UPDATE image_proposals SET status='RUNNING' WHERE id=?").run(running.id);
 const hash=(await import('node:crypto')).createHash('sha256').update(JSON.stringify(confirmed)).digest('hex');db.prepare("UPDATE image_proposals SET status='CREATING',confirmed_json=?,confirmed_hash=?,create_token='expired',create_lease_until='2020-01-01T00:00:00Z' WHERE id=?").run(JSON.stringify(confirmed),hash,creating.id);
 now=new Date(now.getTime()+7*86400000+1);store.cleanup();expect(store.get(consumed.id)).toBeNull();expect(store.get(ready.id)).toBeNull();expect(store.get(running.id)).toBeNull();expect(store.get(creating.id)?.status).toBe('CONSUMED');db.close();
});
