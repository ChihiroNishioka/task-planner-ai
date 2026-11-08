import { Resolver } from 'node:dns/promises';
import { request, type IncomingMessage } from 'node:http';
import { connect, isIP } from 'node:net';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import { Duplex } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { decodeText, extractText } from '../domain/html-text';
import { isBlockedAddress, validateUrl } from '../domain/url-policy';
import { fetchErrors, referenceLimits, type FetchErrorCode, type FetchResult } from '../domain/references';

export type DialTarget = { ip:string; host:string; port:number; tls:boolean; servername?:string; rejectUnauthorized:true; verifyHostname:string };
export type Dial = (target:DialTarget,signal:AbortSignal)=>Duplex;
export type Resolve = (hostname:string,signal:AbortSignal)=>Promise<string[]>;
export type FetchOptions = { resolve?:Resolve; dial?:Dial; timeoutMs?:number };
type DnsResolver = { resolve4:(hostname:string)=>Promise<string[]>; resolve6:(hostname:string)=>Promise<string[]>; cancel:()=>void };
class FetchFailure extends Error { constructor(readonly code:FetchErrorCode){super(code);} }
function fail(code:FetchErrorCode):never {throw new FetchFailure(code);}
function errorCode(error:unknown):FetchErrorCode {
  if(error instanceof FetchFailure)return error.code;
  if(error instanceof Error && error.message==='DECODE_FAILED')return 'DECODE_FAILED';
  return 'NETWORK_ERROR';
}
export async function resolveAll(hostname:string, signal:AbortSignal, resolver:DnsResolver=new Resolver({timeout:3000,tries:1})):Promise<string[]> {
  const cancel=()=>resolver.cancel(); signal.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,3000);
  try {
    const families=await Promise.allSettled([resolver.resolve4(hostname),resolver.resolve6(hostname)]);
    const addresses:string[]=[];
    for(const family of families) {
      if(family.status==='fulfilled')addresses.push(...family.value);
      else { const reason:unknown=family.reason; if(!(reason instanceof Error && 'code' in reason && ['ENODATA','ENOTFOUND'].includes(String(reason.code))))fail('DNS_FAILED'); }
    }
    if(!addresses.length)fail('DNS_FAILED');
    return addresses;
  } finally {clearTimeout(timer);signal.removeEventListener('abort',cancel);}
}
export const defaultDial:Dial = (target,signal)=> {
  const socket=target.tls ? tlsConnect({host:target.ip,port:target.port,servername:target.servername,rejectUnauthorized:true,ALPNProtocols:['http/1.1'],checkServerIdentity:(_host,cert)=>checkServerIdentity(target.verifyHostname,cert)}) : connect({host:target.ip,port:target.port});
  const abort=()=>socket.destroy(new FetchFailure('TIMEOUT'));signal.addEventListener('abort',abort,{once:true});socket.once('close',()=>signal.removeEventListener('abort',abort));return socket;
};
function open(url:URL,target:DialTarget,signal:AbortSignal,dial:Dial):Promise<IncomingMessage> {
  return new Promise((resolve,reject)=> {
    const req=request({method:'GET',hostname:target.ip,port:target.port,path:url.pathname+url.search,headers:{Host:url.host,'User-Agent':'TaskPlannerAI-ReferenceFetcher/1.0',Accept:'text/html,text/plain','Accept-Encoding':'gzip',Connection:'close'},createConnection:()=>dial(target,signal),signal},resolve);
    req.once('error',reject);req.end();
  });
}
async function readBody(response:IncomingMessage):Promise<Buffer> {
  const length=response.headers['content-length'];
  if(length && (!/^\d+$/.test(length)||Number(length)>referenceLimits.bytes)){response.destroy();fail('TOO_LARGE');}
  const encoding=response.headers['content-encoding']?.toLowerCase();
  if(encoding && encoding!=='identity' && encoding!=='gzip'){response.destroy();fail('UNSUPPORTED_TYPE');}
  let compressed=0;let expanded=0;
  const gunzip=encoding==='gzip'?createGunzip():undefined;
  const output=gunzip??response;
  if(gunzip) {
    response.on('data',(chunk:Buffer)=>{compressed+=chunk.length;if(compressed>referenceLimits.bytes){response.destroy(new FetchFailure('TOO_LARGE'));output.destroy(new FetchFailure('TOO_LARGE'));}});
    response.once('error',error=>gunzip.destroy(error));response.pipe(gunzip);
  }
  const chunks:Buffer[]=[];
  try {
    for await(const part of output) {
      const chunk=Buffer.isBuffer(part)?part:Buffer.from(part); expanded+=chunk.length;
      if(expanded>referenceLimits.bytes){response.destroy();fail('TOO_LARGE');}
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {output.destroy();response.destroy();}
}
export async function fetchReference(input:string, options:FetchOptions={}):Promise<FetchResult> {
  const controller=new AbortController(); const {signal}=controller;
  const timeoutMs=options.timeoutMs??referenceLimits.timeoutMs;
  let timer:ReturnType<typeof setTimeout> | undefined;
  const timeout=new Promise<FetchResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({ok:false,code:'TIMEOUT'});},timeoutMs);});
  const run=async():Promise<FetchResult>=> {
    try {
      let next=input;
      for(let hop=0;hop<=5;hop++) {
        let url:URL; try{url=validateUrl(next);}catch{fail('BLOCKED_URL');}
        const hostname=url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'');
        let addresses:string[];
        if(isIP(hostname))addresses=[hostname];
        else {try{addresses=await (options.resolve??resolveAll)(hostname,signal);}catch{fail('DNS_FAILED');}}
        if(!addresses.length)fail('DNS_FAILED');
        if(addresses.some(isBlockedAddress))fail('BLOCKED_URL');
        if(signal.aborted)fail('TIMEOUT');
        addresses.sort((a,b)=>isIP(a)-isIP(b));
        let response:IncomingMessage | undefined;
        for(const ip of addresses.slice(0,3)) {
          const target:DialTarget={ip,host:ip,port:Number(url.port)||(url.protocol==='https:'?443:80),tls:url.protocol==='https:',rejectUnauthorized:true,verifyHostname:hostname,...(!isIP(hostname)?{servername:hostname}:{})};
          try {response=await open(url,target,signal,options.dial??defaultDial);break;}catch {if(signal.aborted)fail('TIMEOUT');}
        }
        if(!response)fail('NETWORK_ERROR');
        const status=response.statusCode??0;
        if([301,302,303,307,308].includes(status)) {
          const location=response.headers.location;response.destroy();
          if(!location)fail('HTTP_ERROR');
          if(hop===5)fail('TOO_MANY_REDIRECTS');
          try {next=new URL(location,url).href;}catch{fail('BLOCKED_URL');}continue;
        }
        if(status<200||status>=300){response.destroy();fail('HTTP_ERROR');}
        const rawType=response.headers['content-type']??'';const contentType=rawType.split(';')[0].trim().toLowerCase();
        if(!['text/html','text/plain'].includes(contentType)){response.destroy();fail('UNSUPPORTED_TYPE');}
        const bytes=await readBody(response);const text=decodeText(bytes,rawType);const result=extractText(text,contentType,hostname);
        if(!result.body)fail('EMPTY_CONTENT');
        return {ok:true,...result,contentType,finalUrl:url.href};
      }
      return {ok:false,code:'TOO_MANY_REDIRECTS'};
    }catch(error){return {ok:false,code:signal.aborted?'TIMEOUT':errorCode(error)};}
  };
  try{return await Promise.race([run(),timeout]);}finally{clearTimeout(timer);controller.abort();}
}

export function createReferenceFetcherFromEnv(env:{NODE_ENV?:string;REFERENCE_FETCH_MODE?:string}=process.env):{mode:'live'|'fixture';fetch:(url:string)=>Promise<FetchResult>} {
  const mode=env.REFERENCE_FETCH_MODE??'live';
  if(!['live','fixture','off'].includes(mode))throw new Error('URL取得モードが不正です');
  if(mode==='fixture' && env.NODE_ENV==='production')throw new Error('本番ではテスト用URL取得を使えません');
  if(mode==='off')return {mode:'live',fetch:async()=>({ok:false,code:'FETCH_DISABLED'})};
  if(mode==='fixture')return {mode:'fixture',fetch:url=>fetchReference(url,{
    resolve:async hostname=>hostname==='example.com'?['93.184.215.14']:hostname==='private.example.com'?['10.0.0.1']:[],
    dial:(target,signal)=> {if(target.verifyHostname!=='example.com')fail('NETWORK_ERROR');const socket=connect({host:'127.0.0.1',port:3351});const abort=()=>socket.destroy();signal.addEventListener('abort',abort,{once:true});socket.once('close',()=>signal.removeEventListener('abort',abort));return socket;},
  })};
  return {mode:'live',fetch:url=>fetchReference(url)};
}

export function fetchErrorMessage(code:FetchErrorCode){return fetchErrors[code];}
