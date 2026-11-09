import { isIP } from 'node:net';
import { request } from 'node:http';
import { z } from 'zod';
import { isBlockedAddress, validateUrl } from '../domain/url-policy';
import type { Dial, Resolve } from './reference-fetcher';
export type ReferenceDnsEnv = { REFERENCE_DNS_MODE?:string; REFERENCE_DOH_URL?:string; REFERENCE_DOH_IPS?:string };
export type ReferenceDnsConfig = {mode:'system'} | {mode:'doh';url:URL;ips:string[]};
const defaultUrl='https://dns.google/resolve';
export function parseReferenceDnsConfig(env:ReferenceDnsEnv):ReferenceDnsConfig {
  const mode=env.REFERENCE_DNS_MODE??'system';
  if(mode!=='system'&&mode!=='doh')throw new Error('名前解決モードが不正です');
  if(mode==='system')return {mode};
  let url:URL;
  try {url=validateUrl(env.REFERENCE_DOH_URL??defaultUrl);if(url.protocol!=='https:'||url.search||url.hash||url.pathname==='/'||isIP(url.hostname.replace(/^\[|\]$/g,''))||(url.port&&url.port!=='443'))throw new Error();}catch{throw new Error('公開DNSのURL設定が不正です');}
  const raw=env.REFERENCE_DOH_IPS??(url.href===defaultUrl?'8.8.8.8,8.8.4.4':undefined);
  if(!raw)throw new Error('公開DNSの接続先設定が不正です');
  const ips=raw.split(',');
  if(ips.length>4||ips.some(ip=>!isIP(ip)||isBlockedAddress(ip)))throw new Error('公開DNSの接続先設定が不正です');
  return {mode,url,ips};
}
export class DnsFailure extends Error {
  readonly code='DNS_FAILED';
  constructor(readonly reason:'DNS_NOT_FOUND'|'DNS_UNAVAILABLE'){super('DNS_FAILED');}
}
const answerSchema=z.object({Status:z.number(),TC:z.boolean().optional(),Answer:z.array(z.object({type:z.number(),data:z.string()})).max(100).optional()});
function parseAnswer(text:string,type:1|28):string[] {
  const data=answerSchema.parse(JSON.parse(text));
  if(data.TC||![0,3].includes(data.Status))throw new DnsFailure('DNS_UNAVAILABLE');
  for(const answer of data.Answer??[])if((answer.type===1&&isIP(answer.data)!==4)||(answer.type===28&&(isIP(answer.data)!==6||answer.data.includes('%'))))throw new DnsFailure('DNS_UNAVAILABLE');
  return data.Status===3?[]:(data.Answer??[]).filter(answer=>answer.type===type).map(answer=>answer.data);
}
function query(config:Extract<ReferenceDnsConfig,{mode:'doh'}>,ip:string,hostname:string,type:1|28,signal:AbortSignal,dial:Dial):Promise<string[]> {
  return new Promise((resolve,reject)=>{
    const path=`${config.url.pathname}?name=${encodeURIComponent(hostname)}&type=${type===1?'A':'AAAA'}`;
    const target={ip,host:ip,port:443,tls:true,servername:config.url.hostname,verifyHostname:config.url.hostname,rejectUnauthorized:true} satisfies Parameters<Dial>[0];
    const req=request({method:'GET',hostname:ip,port:443,path,headers:{Host:config.url.host,Accept:'application/dns-json','Accept-Encoding':'identity','User-Agent':'TaskPlannerAI/1.0',Connection:'close'},createConnection:()=>dial(target,signal),signal},response=>{
      const contentType=(response.headers['content-type']??'').split(';')[0].trim().toLowerCase();
      const encoding=response.headers['content-encoding'];const length=response.headers['content-length'];
      if(response.statusCode!==200||!['application/json','application/dns-json'].includes(contentType)||(encoding&&encoding.toLowerCase()!=='identity')||(length&&(!/^\d+$/.test(length)||Number(length)>65536))){response.destroy();reject(new DnsFailure('DNS_UNAVAILABLE'));return;}
      void (async()=>{try{const chunks:Buffer[]=[];let size=0;for await(const part of response){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);size+=chunk.length;if(size>65536)throw new DnsFailure('DNS_UNAVAILABLE');chunks.push(chunk);}resolve(parseAnswer(Buffer.concat(chunks).toString('utf8'),type));}catch{reject(new DnsFailure('DNS_UNAVAILABLE'));}finally{response.destroy();}})();
    });
    req.once('error',()=>reject(new DnsFailure('DNS_UNAVAILABLE')));req.end();
  });
}
export function createDohResolver(config:Extract<ReferenceDnsConfig,{mode:'doh'}>,dial:Dial):Resolve {
  return async(hostname,signal)=>{
    if(hostname.length>253||hostname.split('.').some(label=>!/^[a-z0-9_-]{1,63}$/i.test(label)))throw new DnsFailure('DNS_NOT_FOUND');
    const budget=new AbortController();const abort=()=>budget.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)budget.abort();
    const budgetTimer=setTimeout(()=>budget.abort(),4000);
    const family=async(type:1|28)=>{
      for(const ip of config.ips){if(budget.signal.aborted)break;const attempt=new AbortController();const cancel=()=>attempt.abort();budget.signal.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,2500);
        try{return await query(config,ip,hostname,type,attempt.signal,dial);}catch{if(budget.signal.aborted)break;}finally{clearTimeout(timer);budget.signal.removeEventListener('abort',cancel);attempt.abort();}
      }
      throw new DnsFailure('DNS_UNAVAILABLE');
    };
    try{const families=await Promise.allSettled([family(1),family(28)]);const addresses:string[]=[];for(const result of families){if(result.status==='rejected')throw new DnsFailure('DNS_UNAVAILABLE');addresses.push(...result.value);}if(!addresses.length)throw new DnsFailure('DNS_NOT_FOUND');return [...new Set(addresses)];}finally{clearTimeout(budgetTimer);signal.removeEventListener('abort',abort);budget.abort();}
  };
}
