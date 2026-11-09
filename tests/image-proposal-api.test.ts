import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {TaskStore} from '../src/adapters/task-store';
import {InputStore} from '../src/adapters/input-store';
import {ImageProposalStore} from '../src/adapters/image-proposal-store';
import {createImageProposalApi} from '../src/adapters/image-proposal-api';
import {createSessionToken} from '../src/domain/session';
import {createImageProposalAi} from '../src/adapters/image-proposal-ai';
const active=vi.hoisted(()=>({api:null as ReturnType<typeof createImageProposalApi>|null}));
vi.mock('../src/adapters/runtime',()=>({get imageProposalApi(){return active.api;},get inputStore(){return inputs;},get taskStore(){return tasks;}}));
let dir:string,tasks:TaskStore,inputs:InputStore,store:ImageProposalStore,api:ReturnType<typeof createImageProposalApi>,cookie:string;
const jpeg=Buffer.from([255,216,255,217]);
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'image-api-'));const path=join(dir,'db');tasks=new TaskStore(path);inputs=new InputStore(path,join(dir,'blobs'));store=new ImageProposalStore(path,join(dir,'blobs'),{tasks,inputs});const secret=randomBytes(32).toString('hex');vi.stubEnv('SESSION_SECRET',secret);vi.stubEnv('ALLOWED_EMAILS','owner@example.com');vi.stubEnv('AUTH_MODE','test');cookie=`task-planner-session=${createSessionToken(secret,'owner@example.com')}`;
 api=createImageProposalApi({store,tasks,inputs,blobDirectory:join(dir,'blobs'),normalizer:async input=>({bytes:jpeg,name:input.name.replace(/\.[^.]+$/,'.jpg'),sourceFormat:'JPEG',width:2,height:2})});active.api=api;
});
afterEach(()=>{store.close();inputs.close();tasks.close();rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
function req(method='GET',body?:BodyInit,headers:Record<string,string>={}){return new Request('http://app.example/api/image-proposals',{method,headers:{cookie,host:'app.example',origin:'http://app.example',...headers},...(body===undefined?{}:{body})});}
function form(bytes:Buffer=jpeg,type='image/jpeg'){const f=new FormData();f.append('image',new Blob([new Uint8Array(bytes)],{type}),'合成.jpg');f.append('note','元のメモ');return f;}
async function enqueue(key=randomUUID()){return api.POST(req('POST',form(),{'idempotency-key':key}));}
const command={title:'確認後の題名',deadline:'2026-11-30',description:'説明',note:'確認後のメモ',extractedText:'勝手な本文'};
function create(id:string,body=command){return api.taskPOST(req('POST',JSON.stringify(body),{'content-type':'application/json'}),id);}
it('A-01 全6エンドポイントは未認証を先に拒否し本文やストアへ触れない',async()=>{
 for(const invalid of ['', 'task-planner-session=forged']){const request=()=>req('POST','読んではいけない',{cookie:invalid});const id=randomUUID();const responses=await Promise.all([api.POST(request()),api.GET(request(),id),api.DELETE(request(),id),api.imageGET(request(),id),api.taskPOST(request(),id),api.contentGET(request(),id,randomUUID())]);for(const response of responses){expect(response.status).toBe(401);expect(await response.json()).toMatchObject({code:'UNAUTHENTICATED'});}}
 expect(tasks.list()).toEqual([]);expect(readdirSync(join(dir,'blobs')).filter(n=>n.endsWith('.blob'))).toEqual([]);
});
it('A-02/A-03/A-04 同一Originのmultipart、再送とキー再利用を検証する',async()=>{
 expect((await api.POST(req('POST',form(),{origin:'https://other.example.com','idempotency-key':randomUUID()}))).status).toBe(403);
 expect((await api.POST(req('POST',form()))).status).toBe(422);
 const key=randomUUID();const response=await enqueue(key);expect(response.status).toBe(202);const first=await response.json();const again=await enqueue(key);expect(again.status).toBe(200);expect((await again.json()).proposal.id).toBe(first.proposal.id);
 const other=form();other.set('note','別のメモ');expect((await api.POST(req('POST',other,{'idempotency-key':key}))).status).toBe(409);
 expect((await api.DELETE(req('DELETE',undefined,{origin:'https://other.example.com'}),first.proposal.id)).status).toBe(403);
 expect((await api.taskPOST(req('POST',JSON.stringify(command),{origin:'https://other.example.com','content-type':'application/json'}),first.proposal.id)).status).toBe(403);
});
it('A-06/A-07 キュー上限と未完了提案の作成拒否',async()=>{
 const first=await (await enqueue()).json();expect((await create(first.proposal.id)).status).toBe(409);await enqueue();await enqueue();expect((await enqueue()).status).toBe(429);
});
it('A-08/A-10/A-11/A-13 mockの確認値で作成し重複せず、抽出本文を保存しない',async()=>{
 const id=(await (await enqueue()).json()).proposal.id;await store.runNext(createImageProposalAi({AI_MODE:'mock'}));const ready=await api.GET(req(),id);expect((await ready.json()).proposal).toMatchObject({status:'READY',mode:'mock'});
 const response=await create(id);expect(response.status).toBe(201);const data=await response.json();expect(data.task).toMatchObject({title:command.title,deadline:command.deadline,originalInput:command.note});expect(data.input).toMatchObject({type:'IMAGE',mime:'image/jpeg',analysisStatus:'NOT_PROCESSED'});expect(data.input.extractedText).toBeUndefined();
 const duplicate=await create(id);expect(duplicate.status).toBe(200);expect((await duplicate.json()).task.id).toBe(data.task.id);expect(inputs.list(data.task.id)).toHaveLength(1);
 const image=await api.contentGET(req(),data.task.id,data.input.id);expect(image.status).toBe(200);expect(image.headers.get('cache-control')).toBe('private, no-store');expect(image.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");expect(image.headers.get('x-content-type-options')).toBe('nosniff');expect((await api.contentGET(req(),randomUUID(),data.input.id)).status).toBe(404);
 const pdf=inputs.addBatch(data.task.id,[{type:'PDF',mime:'application/pdf',name:'synthetic.pdf',bytes:Buffer.from('%PDF-1.7 synthetic')}])[0];expect((await api.contentGET(req(),data.task.id,pdf.id)).status).toBe(404);expect((await api.DELETE(req('DELETE'),id)).status).toBe(204);expect(store.get(id)?.status).toBe('CONSUMED');expect(tasks.get(data.task.id)).toBeDefined();
});
it('A-09 編集した抽出文のみ分析行へ保存しAPIの入力一覧から除く',async()=>{
 const id=(await (await enqueue()).json()).proposal.id;await store.runNext({analyze:async()=>({mode:'ai',fallbackReason:null,suggestion:{title:'候補',deadline:null,description:'',extractedText:'元の文',noTaskFound:false}})});const response=await create(id,{...command,extractedText:'利用者が確認した合成文'});expect(response.status).toBe(201);const data=await response.json();expect(inputs.list(data.task.id)[0]).toMatchObject({analysisStatus:'EXTRACTED',extractedText:'利用者が確認した合成文'});expect(data.input.extractedText).toBeUndefined();
 const {GET}=await import('../src/app/api/tasks/[id]/inputs/route');const listed=await GET(req(),{params:Promise.resolve({id:data.task.id})});expect(listed.status).toBe(200);const body=await listed.json();expect(body.inputs[0].analysisStatus).toBe('EXTRACTED');expect(JSON.stringify(body)).not.toContain('利用者が確認した合成文');expect(body.inputs[0].extractedText).toBeUndefined();
});
it('A-12 DELETEは提案と画像を削除、取得は404',async()=>{const id=(await (await enqueue()).json()).proposal.id;expect((await api.imageGET(req(),id)).status).toBe(200);expect((await api.DELETE(req('DELETE'),id)).status).toBe(204);expect((await api.GET(req(),id)).status).toBe(404);});
it('A-12 受付前に取り消したアップロードは本文を読まず提案も画像も残さない',async()=>{
 const controller=new AbortController();controller.abort();
 const request=new Request(req('POST',form(),{'idempotency-key':randomUUID()}),{signal:controller.signal});
 const body=request.body;if(!body)throw new Error('テスト用の画像本文がありません。');
 const bodyRead=vi.spyOn(body,'getReader');
 const response=await api.POST(request);
 expect(response.status).toBe(499);expect((await response.json()).code).toBe('UPLOAD_CANCELLED');expect(bodyRead).not.toHaveBeenCalled();
 expect(await store.runNext(createImageProposalAi({AI_MODE:'mock'}))).toBe(false);expect(readdirSync(join(dir,'blobs','proposals'))).toEqual([]);expect(tasks.list()).toEqual([]);
});
it('A-12 正規化中に取り消したアップロードはIDを返さず提案も画像も残さない',async()=>{
 const controller=new AbortController();
 const cancelledApi=createImageProposalApi({store,tasks,inputs,blobDirectory:join(dir,'blobs'),normalizer:async input=>{
  controller.abort();return {bytes:jpeg,name:input.name,sourceFormat:'JPEG',width:2,height:2};
 }});
 const request=new Request(req('POST',form(),{'idempotency-key':randomUUID()}),{signal:controller.signal});
 const response=await cancelledApi.POST(request);
 expect(response.status).toBe(499);expect((await response.json()).code).toBe('UPLOAD_CANCELLED');
 expect(await store.runNext(createImageProposalAi({AI_MODE:'mock'}))).toBe(false);expect(readdirSync(join(dir,'blobs','proposals'))).toEqual([]);expect(tasks.list()).toEqual([]);
});
it('E2Eの事前掃除で満杯の提案キューを空にし、次の画像だけを処理する',async()=>{
 const ids:string[]=[];
 for(let i=0;i<3;i++){const response=await enqueue();expect(response.status).toBe(202);ids.push((await response.json()).proposal.id);}
 expect((await enqueue()).status).toBe(429);
 for(const id of ids){expect((await api.DELETE(req('DELETE'),id)).status).toBe(204);expect((await api.GET(req(),id)).status).toBe(404);expect((await api.imageGET(req(),id)).status).toBe(404);}
 expect(readdirSync(join(dir,'blobs','proposals'))).toEqual([]);
 const next=await enqueue();expect(next.status).toBe(202);const id=(await next.json()).proposal.id;
 expect(await store.runNext(createImageProposalAi({AI_MODE:'mock'}))).toBe(true);
 expect((await (await api.GET(req(),id)).json()).proposal).toMatchObject({id,status:'READY',mode:'mock'});
 expect(await store.runNext(createImageProposalAi({AI_MODE:'mock'}))).toBe(false);
});
it('A-18 本文は実受信量で止め、長さが大きければ読まず拒否',async()=>{
 let reads=0,cancelled=false;const stream=()=>new ReadableStream<Uint8Array>({pull(controller){reads++;controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
 const r=new Request('http://app.example/api/image-proposals',{method:'POST',headers:{cookie,host:'app.example',origin:'http://app.example','content-type':'multipart/form-data; boundary=x','idempotency-key':randomUUID()},body:stream(),duplex:'half'} as RequestInit);
 const response=await api.POST(r);expect(response.status).toBe(413);expect(cancelled).toBe(true);expect(reads).toBeLessThan(15);
 reads=0;cancelled=false;const smaller=new Request('http://app.example/api/image-proposals',{method:'POST',headers:{cookie,host:'app.example',origin:'http://app.example','content-length':'1','content-type':'multipart/form-data; boundary=x','idempotency-key':randomUUID()},body:stream(),duplex:'half'} as RequestInit);expect((await api.POST(smaller)).status).toBe(413);expect(cancelled).toBe(true);expect(reads).toBeLessThan(15);
 let read=false;const lengthRequest=new Request('http://app.example/api/image-proposals',{method:'POST',headers:{cookie,host:'app.example',origin:'http://app.example','content-length':String(11*1024*1024+1),'idempotency-key':randomUUID()},body:new ReadableStream({start(){},pull(){read=true;}},{highWaterMark:0}),duplex:'half'} as RequestInit);expect((await api.POST(lengthRequest)).status).toBe(413);expect(read).toBe(false);
});
it('A-19 multipartの枚数・型・未知項目・メモ上限を拒否する',async()=>{
 for(const edit of [(f:FormData)=>f.delete('image'),(f:FormData)=>f.append('image',new Blob([jpeg]),'2.jpg'),(f:FormData)=>f.set('image','文字')]){const f=form();edit(f);const response=await api.POST(req('POST',f,{'idempotency-key':randomUUID()}));expect(response.status).toBe(422);expect((await response.json()).code).toBe('IMAGE_REQUIRED');}
 for(const edit of [(f:FormData)=>f.append('unknown','x'),(f:FormData)=>f.append('note','x'),(f:FormData)=>f.set('note',new Blob(['x'])),(f:FormData)=>f.set('note','x'.repeat(2001))]){const f=form();edit(f);expect((await api.POST(req('POST',f,{'idempotency-key':randomUUID()}))).status).toBe(422);}
 expect((await api.POST(req('POST','bad',{'idempotency-key':randomUUID()}))).status).toBe(422);expect(tasks.list()).toEqual([]);
});

it('A-01 handler直呼びで6エンドポイントの認証を検証する',async()=>{
 const root=await import('../src/app/api/image-proposals/route');const item=await import('../src/app/api/image-proposals/[id]/route');const image=await import('../src/app/api/image-proposals/[id]/image/route');const task=await import('../src/app/api/image-proposals/[id]/task/route');const content=await import('../src/app/api/tasks/[id]/inputs/[inputId]/content/route');
 const context={params:Promise.resolve({id:randomUUID(),inputId:randomUUID()})};
 for(const invalid of ['', 'task-planner-session=forged']){
 const r=()=>req('POST','unread',{cookie:invalid});
 for(const response of await Promise.all([root.POST(r()),item.GET(r(),context),item.DELETE(r(),context),image.GET(r(),context),task.POST(r(),context),content.GET(r(),context)])){expect(response.status).toBe(401);expect((await response.json()).code).toBe('UNAUTHENTICATED');}
 }
 expect(tasks.list()).toEqual([]);
});
it('A-05 実正規化の拒否は行とファイルを作らない',async()=>{
 const real=createImageProposalApi({store,tasks,inputs,blobDirectory:join(dir,'blobs')});
 const invalid=[{bytes:Buffer.alloc(10*1024*1024+1),type:'image/jpeg',status:413,code:'IMAGE_TOO_LARGE'},{bytes:Buffer.from('GIF89a'),type:'image/gif',status:415,code:'IMAGE_UNSUPPORTED'},{bytes:jpeg,type:'image/heic',status:422,code:'IMAGE_MISMATCH'},{bytes:Buffer.from('0000ftypheic0000heic'),type:'image/heic',status:422,code:'HEIC_CONVERT_FAILED'}];
 for(const item of invalid){const response=await real.POST(req('POST',form(item.bytes,item.type),{'idempotency-key':randomUUID()}));expect(response.status).toBe(item.status);expect((await response.json()).code).toBe(item.code);}
 expect(tasks.list()).toHaveLength(0);expect(readdirSync(join(dir,'blobs','proposals'))).toHaveLength(0);
});
it('A-07/A-16/A-17 CREATINGの取消拒否、GET復旧と欠落画像、期限切れ',async()=>{
 const id=(await (await enqueue()).json()).proposal.id;await store.runNext(createImageProposalAi({AI_MODE:'mock'}));
 const Database=(await import('better-sqlite3')).default;const db=new Database(join(dir,'db'));
 db.prepare('UPDATE image_proposals SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00Z',id);expect((await create(id)).status).toBe(410);expect((await api.GET(req(),id)).status).toBe(410);
 db.prepare('UPDATE image_proposals SET expires_at=? WHERE id=?').run('2099-01-01T00:00:00Z',id);
 const {createHash}=await import('node:crypto');const confirmed={...command,extractedText:null};const hash=createHash('sha256').update(JSON.stringify(confirmed)).digest('hex');
 db.prepare("UPDATE image_proposals SET status='CREATING',confirmed_json=?,confirmed_hash=?,create_token='held',create_lease_until=? WHERE id=?").run(JSON.stringify(confirmed),hash,'2099-01-01T00:00:00Z',id);expect((await api.DELETE(req('DELETE'),id)).status).toBe(409);
 db.prepare('UPDATE image_proposals SET create_lease_until=? WHERE id=?').run('2020-01-01T00:00:00Z',id);expect((await api.DELETE(req('DELETE'),id)).status).toBe(409);
 const recovered=await api.GET(req(),id);expect(recovered.status).toBe(200);expect((await recovered.json()).proposal).toMatchObject({status:'CONSUMED',createStuck:false});
 const missing=(await (await enqueue()).json()).proposal.id;await store.runNext(createImageProposalAi({AI_MODE:'mock'}));db.prepare("UPDATE image_proposals SET status='CREATING',confirmed_json=?,confirmed_hash=?,create_token='held',create_lease_until=? WHERE id=?").run(JSON.stringify(confirmed),hash,'2020-01-01T00:00:00Z',missing);
 rmSync(join(dir,'blobs','proposals',`${missing}.jpg`));const stuck=await api.GET(req(),missing);expect(stuck.status).toBe(200);expect((await stuck.json()).proposal).toMatchObject({status:'CREATING',createStuck:true});db.close();
});
it('A-15 新規受付時に古いRUNNINGを回収して枠を解放する',async()=>{
 const ids=[];for(let i=0;i<3;i++)ids.push((await (await enqueue()).json()).proposal.id);
 const Database=(await import('better-sqlite3')).default;const db=new Database(join(dir,'db'));db.prepare("UPDATE image_proposals SET status='RUNNING',attempt_token='old',lease_until='2020-01-01T00:00:00Z'").run();
 expect((await enqueue()).status).toBe(202);for(const id of ids)expect((await (await api.GET(req(),id)).json()).proposal.fallbackReason).toBe('WORKER_UNAVAILABLE');db.close();
});
