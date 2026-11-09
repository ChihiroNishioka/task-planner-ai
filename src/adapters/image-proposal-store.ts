import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Task } from '../domain/task';
import { modeLabel } from '../domain/preparation';
import { mockImageSuggestion } from '../domain/image-proposal';
import { createImageTables, readSafeImage, type InputStore, type StoredInput } from './input-store';
import type { TaskStore } from './task-store';
import type { WorkerView } from './worker-status';

export type ImageSuggestion = { title: string | null; deadline: string | null; description: string; extractedText: string | null; noTaskFound: boolean };
export type ImageAnalysis = { suggestion: ImageSuggestion; mode: 'ai' | 'mock' | 'mock_fallback'; fallbackReason: string | null };
export type ProposalImage = { bytes: Buffer; name: string; sourceFormat: 'JPEG' | 'PNG' | 'HEIC'; width: number; height: number };
export type ConfirmedImageTask = { title: string; deadline: string | null; description: string; note: string; extractedText: string | null };
export type ImageProposal = { id: string; status: 'QUEUED' | 'RUNNING' | 'READY' | 'CREATING' | 'CONSUMED'; image: { name: string; sourceFormat: string; width: number; height: number; url: string }; suggestion: ImageSuggestion | null; mode: ImageAnalysis['mode'] | null; modeLabel: string | null; fallbackReason: string | null; taskId: string | null; queueDelayed: boolean; createStuck: boolean; expiresAt: string; note: string };
export type ProposalOptions = { now?: () => Date; workerState?: () => WorkerView['state']; aiTimeoutMs?: number; workerGraceMs?: number; queueNoticeMs?: number; tasks?: TaskStore; inputs?: InputStore; onCreateStage?: (stage: string) => void };
const rowSchema = z.object({
  id:z.string(),operation_key:z.string(),request_hash:z.string(),status:z.enum(['QUEUED','RUNNING','READY','CREATING','CONSUMED']),
  original_name:z.string(),stored_name:z.string(),source_format:z.string(),blob_name:z.string(),content_hash:z.string(),byte_size:z.number(),width:z.number(),height:z.number(),note:z.string(),
  mode:z.enum(['ai','mock','mock_fallback']).nullable(),fallback_reason:z.string().nullable(),result_json:z.string().nullable(),attempt_token:z.string().nullable(),lease_until:z.string().nullable(),
  task_id:z.string().nullable(),confirmed_json:z.string().nullable(),confirmed_hash:z.string().nullable(),create_token:z.string().nullable(),create_lease_until:z.string().nullable(),created_at:z.string(),updated_at:z.string(),expires_at:z.string(),
});
type Row = z.infer<typeof rowSchema>;
const resultSchema=z.object({title:z.string().nullable(),deadline:z.string().nullable(),description:z.string(),extractedText:z.string().nullable(),noTaskFound:z.boolean()});
const confirmedSchema=z.object({title:z.string().trim().min(1).max(240),deadline:z.string().date().nullable(),description:z.string().max(2000),note:z.string().max(2000),extractedText:z.string().max(8000).nullable()});
type AnalyzeInput = {imagePath:string;name:string;note:string};
type Runner = ((input:AnalyzeInput)=>Promise<ImageAnalysis>) | {analyze(input:AnalyzeInput):Promise<ImageAnalysis>};
export class ImageProposalError extends Error {
  constructor(readonly code: string) { super(code); this.name='ImageProposalError'; }
}
export class ImageProposalStore {
  private readonly db: Database.Database;
  private readonly proposalDirectory: string;
  private lastCleanup = -Infinity;
  constructor(databasePath: string, private readonly blobDirectory: string, private readonly options: ProposalOptions = {}) {
    mkdirSync(blobDirectory,{recursive:true}); this.proposalDirectory=join(blobDirectory,'proposals'); mkdirSync(this.proposalDirectory,{recursive:true,mode:0o700});
    this.db=new Database(databasePath);this.db.pragma('busy_timeout = 5000');this.db.pragma('journal_mode = WAL');createImageTables(this.db);
  }
  private now(): Date {return this.options.now?.() ?? new Date();}
  private row(id:string):Row|null {return rowSchema.nullable().parse(this.db.prepare('SELECT * FROM image_proposals WHERE id=?').get(id) ?? null);}
  enqueue(input: {operationKey: string; requestHash: string; originalName: string; note: string; image: ProposalImage}): {proposal: ImageProposal; reused: boolean} {
    const result=this.db.transaction(()=>{
      this.recover();
      const prior=rowSchema.nullable().parse(this.db.prepare('SELECT * FROM image_proposals WHERE operation_key=?').get(input.operationKey) ?? null);
      if(prior){if(prior.request_hash!==input.requestHash)throw new ImageProposalError('KEY_REUSED');return {row:prior,reused:true};}
      const count=z.object({count:z.number()}).parse(this.db.prepare("SELECT count(*) count FROM image_proposals WHERE status IN ('QUEUED','RUNNING')").get()).count;
      if(count>=3)throw new ImageProposalError('IMAGE_BUSY');
      const id=randomUUID();const blobName=`${id}.jpg`;const now=this.now();
      writeFileSync(join(this.proposalDirectory,blobName),input.image.bytes,{mode:0o600,flag:'wx'});
      this.db.prepare(`INSERT INTO image_proposals(id,operation_key,request_hash,status,original_name,stored_name,source_format,blob_name,content_hash,byte_size,width,height,note,created_at,updated_at,expires_at)
        VALUES (?,?,?,'QUEUED',?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.operationKey,input.requestHash,input.originalName,input.image.name,input.image.sourceFormat,blobName,createHash('sha256').update(input.image.bytes).digest('hex'),input.image.bytes.length,input.image.width,input.image.height,input.note,now.toISOString(),now.toISOString(),new Date(now.getTime()+86_400_000).toISOString());
      return {row:this.required(id),reused:false};
    }).immediate();
    return {proposal:this.view(result.row),reused:result.reused};
  }
  get(id: string): ImageProposal | null {
    this.db.transaction(()=>this.recover()).immediate();
    let row=this.row(id);if(!row)return null;
    let createStuck=false;
    if(row.status==='CREATING' && this.createExpired(row)) {
      try {this.resume(row);row=this.row(id);}catch{createStuck=true;}
    }
    return row?{...this.view(row),createStuck}:null;
  }
  readImage(id: string): Buffer | null {const row=this.row(id);return row?readSafeImage(this.proposalDirectory,row.blob_name,'jpg'):null;}
  cancel(id: string): void {
    const row=this.db.transaction(()=>{const current=this.row(id);if(!current)throw new ImageProposalError('NOT_FOUND');if(current.status==='CREATING')throw new ImageProposalError('PROPOSAL_CREATING');if(current.status==='CONSUMED')return null;this.db.prepare('DELETE FROM image_proposals WHERE id=?').run(id);return current;}).immediate();
    if(row)this.removeProposalImage(row);
  }
  async runNext(runner: Runner): Promise<boolean> {
    const claimed=this.db.transaction(()=>{
      this.recover();const raw=this.db.prepare("SELECT * FROM image_proposals WHERE status='QUEUED' ORDER BY created_at,id LIMIT 1").get();if(!raw)return null;
      const row=rowSchema.parse(raw);const token=randomUUID();const timeout=Math.max(1000,Math.min(600000,this.options.aiTimeoutMs ?? 120000));
      this.db.prepare("UPDATE image_proposals SET status='RUNNING',attempt_token=?,lease_until=?,updated_at=? WHERE id=? AND status='QUEUED'").run(token,new Date(this.now().getTime()+timeout+30000).toISOString(),this.now().toISOString(),row.id);
      return {...row,attempt_token:token};
    }).immediate();
    if(!claimed)return false;
    let result:ImageAnalysis;
    try {
      if(!this.readImage(claimed.id))throw new Error('IMAGE_MISSING');
      const input={imagePath:join(this.proposalDirectory,claimed.blob_name),name:claimed.stored_name,note:claimed.note};
      result=await (typeof runner==='function'?runner(input):runner.analyze(input));
    }catch{result={mode:'mock_fallback',fallbackReason:'CLI_EXIT',suggestion:mockImageSuggestion({name:claimed.stored_name,note:claimed.note})};}
    const suggestion={...result.suggestion,extractedText:result.mode==='ai'?result.suggestion.extractedText:null};
    this.db.prepare("UPDATE image_proposals SET status='READY',mode=?,fallback_reason=?,result_json=?,attempt_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='RUNNING' AND attempt_token=?")
      .run(result.mode,result.fallbackReason,JSON.stringify(suggestion),this.now().toISOString(),claimed.id,claimed.attempt_token);
    return true;
  }
  createTask(id: string, input: ConfirmedImageTask, tasks=this.options.tasks, inputs=this.options.inputs): {task: Task; input: StoredInput; reused: boolean} {
    const claim=this.db.transaction(()=>{
      const row=this.required(id);const confirmed=confirmedSchema.parse({...input,extractedText:row.mode==='ai'?input.extractedText:null});const hash=this.hash(confirmed);
      if(row.status==='QUEUED'||row.status==='RUNNING')throw new ImageProposalError('PROPOSAL_NOT_READY');
      if(row.status==='READY'&&Date.parse(row.expires_at)<=this.now().getTime())throw new ImageProposalError('PROPOSAL_EXPIRED');
      if(row.status==='CONSUMED'||row.status==='CREATING') {
        if(row.confirmed_hash!==hash)throw new ImageProposalError('PROPOSAL_ALREADY_CONFIRMED');
        if(row.status==='CONSUMED')return {row,reused:true};
        if(!this.createExpired(row))throw new ImageProposalError('PROPOSAL_CREATING');
      }
      const token=randomUUID();
      this.db.prepare("UPDATE image_proposals SET status='CREATING',confirmed_json=COALESCE(confirmed_json,?),confirmed_hash=?,create_token=?,create_lease_until=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(confirmed),hash,token,new Date(this.now().getTime()+60000).toISOString(),this.now().toISOString(),id);
      return {row:this.required(id),reused:row.status==='CREATING'};
    }).immediate();
    if(claim.row.status==='CONSUMED'){this.removeProposalImage(claim.row);return {...this.createdResult(claim.row,tasks,inputs),reused:true};}
    try {this.options.onCreateStage?.('admitted');return {...this.execute(claim.row,tasks,inputs),reused:claim.reused};}
    catch(error){this.release(claim.row);throw error;}
  }
  private execute(row:Row,tasks=this.options.tasks,inputs=this.options.inputs):{task:Task;input:StoredInput} {
    if(!tasks||!inputs)throw new Error('タスクと添付の保存先がありません。');
    const current=this.required(row.id);if(current.status!=='CREATING'||current.create_token!==row.create_token)throw new ImageProposalError('PROPOSAL_CREATING');
    if(!row.confirmed_json)throw new Error('確定入力がありません。');
    const confirmed=confirmedSchema.parse(JSON.parse(row.confirmed_json));
    const bytes=this.readImage(row.id);if(!bytes)throw new Error('画像がありません。');
    const task=tasks.create({title:confirmed.title,deadline:confirmed.deadline,description:confirmed.description,originalInput:confirmed.note||confirmed.title},`image-proposal:${row.id}`);
    this.options.onCreateStage?.('task');
    const input=inputs.addProposalImage(task.id,row.id,{bytes,name:row.stored_name},()=>this.options.onCreateStage?.('blob'));
    this.options.onCreateStage?.('input');
    if(row.mode==='ai'&&confirmed.extractedText?.trim())inputs.addAnalysis({inputId:input.id,taskId:task.id,mode:row.mode,extractedText:confirmed.extractedText,proposalId:row.id});
    this.options.onCreateStage?.('analysis');
    const updated=this.db.prepare("UPDATE image_proposals SET status='CONSUMED',task_id=?,result_json=NULL,note='',confirmed_json=NULL,attempt_token=NULL,lease_until=NULL,create_token=NULL,create_lease_until=NULL,updated_at=? WHERE id=? AND status='CREATING' AND create_token=?")
      .run(task.id,this.now().toISOString(),row.id,row.create_token);
    if(!updated.changes)throw new ImageProposalError('PROPOSAL_CREATING');
    this.options.onCreateStage?.('consumed');this.removeProposalImage(row);this.options.onCreateStage?.('imageDeleted');
    return {task,input:inputs.list(task.id).find(entry=>entry.id===input.id)??input};
  }
  private resume(row:Row):void {
    const claim=this.db.transaction(()=>{
      const current=this.required(row.id);if(current.status!=='CREATING'||!this.createExpired(current))return null;
      this.db.prepare("UPDATE image_proposals SET create_token=?,create_lease_until=? WHERE id=? AND status='CREATING'").run(randomUUID(),new Date(this.now().getTime()+60000).toISOString(),row.id);
      return this.required(row.id);
    }).immediate();
    if(!claim)return;
    try{this.execute(claim);}catch(error){this.release(claim);throw error;}
  }
  private release(row:Row):void {this.db.prepare("UPDATE image_proposals SET create_lease_until=? WHERE id=? AND status='CREATING' AND create_token=?").run(this.now().toISOString(),row.id,row.create_token);}
  private createdResult(row:Row,tasks:TaskStore|undefined,inputs:InputStore|undefined):{task:Task;input:StoredInput} {
    if(!row.task_id||!tasks||!inputs)throw new Error('作成したタスクを取得できません。');
    const task=tasks.get(row.task_id);const input=inputs.list(row.task_id).find(entry=>entry.path.endsWith(`${row.id}.blob`));
    if(!task||!input)throw new Error('作成したタスクを取得できません。');return {task,input};
  }
  private recover():void {
    const now=this.now();const rows=z.array(rowSchema).parse(this.db.prepare("SELECT * FROM image_proposals WHERE status IN ('QUEUED','RUNNING')").all());
    for(const row of rows){
      const unavailable=row.status==='RUNNING'?row.lease_until!==null&&Date.parse(row.lease_until)<=now.getTime():(this.options.workerState?.()??'never')!=='running'&&now.getTime()-Date.parse(row.created_at)>=this.clamp(this.options.workerGraceMs,20000);
      if(!unavailable)continue;
      this.db.prepare("UPDATE image_proposals SET status='READY',mode='mock_fallback',fallback_reason='WORKER_UNAVAILABLE',result_json=?,attempt_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status=? AND attempt_token IS ?")
        .run(JSON.stringify(mockImageSuggestion({name:row.stored_name,note:row.note})),now.toISOString(),row.id,row.status,row.attempt_token);
    }
  }
  cleanup(): void {
    const now=this.now();if(now.getTime()-this.lastCleanup<600000)return;this.lastCleanup=now.getTime();
    for(const row of z.array(rowSchema).parse(this.db.prepare("SELECT * FROM image_proposals WHERE status='CREATING'").all()))if(this.createExpired(row)){try{this.resume(row);}catch{}}
    const removed=this.db.transaction(()=>{
      const rows=z.array(rowSchema).parse(this.db.prepare("SELECT * FROM image_proposals WHERE (status IN ('QUEUED','RUNNING','READY') AND expires_at<=?) OR (status='CONSUMED' AND updated_at<=?)").all(now.toISOString(),new Date(now.getTime()-7*86_400_000).toISOString()));
      for(const row of rows)this.db.prepare('DELETE FROM image_proposals WHERE id=?').run(row.id);return rows;
    }).immediate();
    for(const row of removed)this.removeProposalImage(row);
    for(const row of z.array(rowSchema).parse(this.db.prepare("SELECT * FROM image_proposals WHERE status='CONSUMED'").all()))this.removeProposalImage(row);
    const orphans=this.db.transaction(()=>readdirSync(this.proposalDirectory).filter(name=>{
      if(!/^[0-9a-f-]{36}\.jpg$/.test(name))return false;
      if(lstatSync(join(this.proposalDirectory,name)).mtimeMs>now.getTime()-3600000)return false;
      return !this.db.prepare('SELECT 1 FROM image_proposals WHERE blob_name=?').get(name);
    })).immediate();
    for(const name of orphans)rmSync(join(this.proposalDirectory,name),{force:true});
    const temporary=join(this.blobDirectory,'tmp');mkdirSync(temporary,{recursive:true,mode:0o700});
    for(const name of readdirSync(temporary)){const path=join(temporary,name);if(lstatSync(path).mtimeMs<=now.getTime()-3600000)rmSync(path,{recursive:true,force:true});}
  }
  private clamp(value:number|undefined,fallback:number):number{return Math.min(600000,Math.max(1000,value??fallback));}
  private createExpired(row:Row):boolean{return row.create_lease_until===null||Date.parse(row.create_lease_until)<=this.now().getTime();}
  private required(id:string):Row {const row=this.row(id);if(!row)throw new ImageProposalError('NOT_FOUND');return row;}
  private hash(input:ConfirmedImageTask):string {return createHash('sha256').update(JSON.stringify(input)).digest('hex');}
  private removeProposalImage(row:Row):void {if(/^[0-9a-f-]{36}\.jpg$/.test(row.blob_name))rmSync(join(this.proposalDirectory,row.blob_name),{force:true});}
  private view(row:Row):ImageProposal {
    return {id:row.id,status:row.status,image:{name:row.stored_name,sourceFormat:row.source_format,width:row.width,height:row.height,url:`/api/image-proposals/${row.id}/image`},suggestion:row.result_json?resultSchema.parse(JSON.parse(row.result_json)):null,mode:row.mode,modeLabel:row.mode?modeLabel(row.mode,row.fallback_reason):null,fallbackReason:row.fallback_reason,taskId:row.task_id,queueDelayed:row.status==='QUEUED'&&this.now().getTime()-Date.parse(row.created_at)>this.clamp(this.options.queueNoticeMs,300000),createStuck:false,expiresAt:row.expires_at,note:row.note};
  }
  close(): void {this.db.close();}
}
