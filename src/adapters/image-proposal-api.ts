import {createHash} from 'node:crypto';
import {isValidSessionToken} from '../domain/session';
import {isSameOriginRequest,validateCsrfRequest} from '../lib/auth';
import {confirmedImageSchema,ImageError} from '../domain/image-proposal';
import {ImageProposalError,type ImageProposalStore} from './image-proposal-store';
import type {InputStore,StoredInput} from './input-store';
import type {TaskStore} from './task-store';
import {normalizeImage} from './image-normalizer';
const messages:Record<string,string>={UPLOAD_CANCELLED:'アップロードを取り消しました。',UNAUTHENTICATED:'ログインが必要です。',ORIGIN_REJECTED:'操作元を確認できません。',NOT_FOUND:'提案が見つかりません。もう一度画像を選んでください。',KEY_REUSED:'この操作キーは別の内容に使われています。',PROPOSAL_NOT_READY:'読み取りがまだ終わっていません。',PROPOSAL_CREATING:'タスクを作成しています。少し待ってください。',PROPOSAL_ALREADY_CONFIRMED:'この提案はすでに別の内容で作成を受け付けています。',PROPOSAL_EXPIRED:'提案の有効期限が切れました。もう一度画像を選んでください。',IMAGE_TOO_LARGE:'画像は10MiB以下にしてください。',IMAGE_UNSUPPORTED:'対応していない形式です。JPEG、PNG、HEIC、HEIFの画像を選んでください。',IMAGE_REQUIRED:'画像を1枚選んでください。',IMAGE_MISMATCH:'ファイル形式と内容が一致しません。',IMAGE_CORRUPT:'画像を読み取れませんでした。ファイルが壊れている可能性があります。',IMAGE_PIXELS_TOO_LARGE:'画像の画素数が大きすぎます。5,000万画素までにしてください。',IMAGE_TOO_COMPLEX:'画像を処理できる大きさにできませんでした。別の画像を選んでください。',HEIC_CONVERT_FAILED:'HEICの画像を変換できませんでした。JPEGやスクリーンショットで選び直してください。',INVALID_INPUT:'入力を確認してください。',IMAGE_BUSY:'読み取りが混み合っています。少し待ってからもう一度お試しください。',IMAGE_PROCESS_TIMEOUT:'画像の処理に時間がかかりすぎました。小さい画像でお試しください。',IMAGE_PROCESS_FAILED:'画像を処理できませんでした。もう一度お試しください。'};
const statuses:Record<string,number>={UPLOAD_CANCELLED:499,UNAUTHENTICATED:401,ORIGIN_REJECTED:403,NOT_FOUND:404,KEY_REUSED:409,PROPOSAL_NOT_READY:409,PROPOSAL_CREATING:409,PROPOSAL_ALREADY_CONFIRMED:409,PROPOSAL_EXPIRED:410,IMAGE_TOO_LARGE:413,IMAGE_UNSUPPORTED:415,IMAGE_BUSY:429,IMAGE_PROCESS_TIMEOUT:503,IMAGE_PROCESS_FAILED:500};
function errorResponse(code:string){return Response.json({error:messages[code]??messages.IMAGE_PROCESS_FAILED,code},{status:statuses[code]??422});}
export function imageRequestAuthenticated(request:Request):boolean {
 const mode=process.env.AUTH_MODE||'firebase';
 if(!['firebase','test'].includes(mode)||(process.env.NODE_ENV==='production'&&mode==='test'))return false;
 const token=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('task-planner-session='))?.slice('task-planner-session='.length);
 return isValidSessionToken(token,process.env.SESSION_SECRET,process.env.ALLOWED_EMAILS??'');
}
function publicInput(input:StoredInput){const {id,taskId,type,mime,name,createdAt,order,mode,analysisStatus}=input;return {id,taskId,type,mime,name,createdAt,order,mode,analysisStatus};}
function imageResponse(bytes:Buffer,mime:string){return new Response(new Uint8Array(bytes),{headers:{'Content-Type':mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});}
async function readMultipart(request:Request):Promise<{file:File;note:string}>{
 const max=11*1024*1024;
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>max)throw new ImageError('IMAGE_TOO_LARGE');
 if(!request.body)throw new ImageError('INVALID_INPUT');
 const reader=request.body.getReader();const chunks:Uint8Array[]=[];let total=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw new ImageError('IMAGE_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
 let form:FormData;
 try{form=await new Response(Buffer.concat(chunks),{headers:{'content-type':request.headers.get('content-type')??''}}).formData();}catch{throw new ImageError('INVALID_INPUT');}
 const images=form.getAll('image');if(images.length!==1||!(images[0] instanceof File))throw new ImageError('IMAGE_REQUIRED');
 const notes=form.getAll('note');if([...form.keys()].some(key=>key!=='image'&&key!=='note')||notes.length>1||(notes.length===1&&(typeof notes[0]!=='string'||notes[0].length>2000)))throw new ImageError('INVALID_INPUT');
 const note=notes[0];return {file:images[0],note:typeof note==='string'?note:''};
}
export function createImageProposalApi(options:{store:ImageProposalStore;tasks:TaskStore;inputs:InputStore;blobDirectory:string;normalizer?:typeof normalizeImage}){
 const {store,tasks,inputs,blobDirectory}=options;
 const guard=(request:Request,mutation=false,json=false)=>!imageRequestAuthenticated(request)?errorResponse('UNAUTHENTICATED'):mutation&&!(json?validateCsrfRequest(request):isSameOriginRequest(request))?errorResponse('ORIGIN_REJECTED'):null;
 const attempt=async(action:()=>Response|Promise<Response>)=>{try{return await action();}catch(error){return errorResponse(error instanceof ImageError||error instanceof ImageProposalError?error.code:'INVALID_INPUT');}};
 return {
 async POST(request:Request):Promise<Response>{const rejected=guard(request,true);if(rejected)return rejected;return attempt(async()=>{
 if(request.signal.aborted)throw new ImageProposalError('UPLOAD_CANCELLED');
 const operationKey=request.headers.get('idempotency-key');if(!operationKey||!/^[-\w.]{1,200}$/.test(operationKey))throw new ImageError('INVALID_INPUT');
 const {file,note}=await readMultipart(request);const bytes=Buffer.from(await file.arrayBuffer());if(bytes.length>10*1024*1024)throw new ImageError('IMAGE_TOO_LARGE');
 if(request.signal.aborted)throw new ImageProposalError('UPLOAD_CANCELLED');
 const requestHash=createHash('sha256').update(bytes).update('\0').update(file.name).update('\0').update(file.type).update('\0').update(note).digest('hex');
 const image=await(options.normalizer??normalizeImage)({bytes,mime:file.type,name:file.name},blobDirectory);
 if(request.signal.aborted)throw new ImageProposalError('UPLOAD_CANCELLED');
 const result=store.enqueue({operationKey,requestHash,originalName:file.name,note,image});return Response.json({proposal:result.proposal},{status:result.reused?200:202});
 });},
 async GET(request:Request,id:string):Promise<Response>{const rejected=guard(request);if(rejected)return rejected;return attempt(()=>{const proposal=store.get(id);if(proposal&&!['CREATING','CONSUMED'].includes(proposal.status)&&Date.parse(proposal.expiresAt)<=Date.now())return errorResponse('PROPOSAL_EXPIRED');return proposal?Response.json({proposal}):errorResponse('NOT_FOUND');});},
 async DELETE(request:Request,id:string):Promise<Response>{const rejected=guard(request,true);if(rejected)return rejected;return attempt(()=>{store.cancel(id);return new Response(null,{status:204});});},
 async imageGET(request:Request,id:string):Promise<Response>{const rejected=guard(request);if(rejected)return rejected;return attempt(()=>{const bytes=store.readImage(id);return bytes?imageResponse(bytes,'image/jpeg'):errorResponse('NOT_FOUND');});},
 async taskPOST(request:Request,id:string):Promise<Response>{const rejected=guard(request,true,true);if(rejected)return rejected;return attempt(async()=>{const parsed=confirmedImageSchema.safeParse(await request.json());if(!parsed.success)throw new ImageError('INVALID_INPUT');const result=store.createTask(id,parsed.data,tasks,inputs);return Response.json({task:result.task,input:publicInput(result.input)},{status:result.reused?200:201});});},
 async contentGET(request:Request,id:string,inputId:string):Promise<Response>{const rejected=guard(request);if(rejected)return rejected;return attempt(()=>{if(!tasks.get(id))return errorResponse('NOT_FOUND');const image=inputs.readImage(id,inputId);return image?imageResponse(image.bytes,image.mime):errorResponse('NOT_FOUND');});},
 };
}
