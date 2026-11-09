import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { buildChildEnv } from './cli-ai';
import { detectImageFormat, ImageError, safeImageName, type ImageFormat, type ImageSource } from '../domain/image-proposal';
export type NormalizedImage = { bytes: Buffer; name: string; sourceFormat: ImageFormat; width: number; height: number };
export type ImageNormalizerOptions = { scriptPath?: string; timeoutMs?: number; rssLimitMb?: number };
let active=0;
const processResult=z.union([z.object({width:z.number().int().positive().max(3000),height:z.number().int().positive().max(3000)}).strict(),z.object({error:z.enum(['IMAGE_CORRUPT','IMAGE_PIXELS_TOO_LARGE','IMAGE_TOO_COMPLEX','HEIC_CONVERT_FAILED'])}).strict()]);
export function imageHeaderPixels(bytes:Buffer,format:ImageFormat):number {
  const fail=()=>new ImageError(format==='HEIC'?'HEIC_CONVERT_FAILED':'IMAGE_CORRUPT');
  if(format==='PNG'){if(bytes.length<24)throw fail();return bytes.readUInt32BE(16)*bytes.readUInt32BE(20);}
  if(format==='HEIC'){
    let maximum=0;let index=bytes.indexOf(Buffer.from('ispe'));
    while(index>=0){if(index+16>bytes.length)throw fail();maximum=Math.max(maximum,bytes.readUInt32BE(index+8)*bytes.readUInt32BE(index+12));index=bytes.indexOf(Buffer.from('ispe'),index+4);}
    if(!maximum)throw fail();return maximum;
  }
  let index=2;
  while(index+4<=bytes.length){
    if(bytes[index]!==255)throw fail();const marker=bytes[index+1];if(marker===255){index++;continue;}
    if(marker===0xd9||marker===0xda)break;
    const length=bytes.readUInt16BE(index+2);if(length<2)throw fail();
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(index+9>bytes.length)throw fail();return bytes.readUInt16BE(index+5)*bytes.readUInt16BE(index+7);
    }
    index+=length+2;
  }
  throw fail();
}
export async function normalizeImage(input:ImageSource,blobDirectory:string,options:ImageNormalizerOptions={}):Promise<NormalizedImage>{
  const sourceFormat=detectImageFormat(input);const pixels=imageHeaderPixels(input.bytes,sourceFormat);
  if(pixels>50_000_000)throw new ImageError('IMAGE_PIXELS_TOO_LARGE');
  if(active>=2)throw new ImageError('IMAGE_BUSY');active++;
  let workdir:string|undefined;
  try {
    const temporary=join(blobDirectory,'tmp');await mkdir(temporary,{recursive:true,mode:0o700});workdir=join(temporary,randomUUID());await mkdir(workdir,{mode:0o700});
    await writeFile(join(workdir,'input'),input.bytes,{mode:0o600});
    const output=await runNormalizer(workdir,sourceFormat,pixels,options);
    const bytes=await readFile(join(workdir,'output.jpg'));
    if(bytes.length>3.5*1024*1024||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw new ImageError('IMAGE_PROCESS_FAILED');
    return {...output,bytes,name:safeImageName(input.name),sourceFormat};
  } catch(error) {if(error instanceof ImageError)throw error;throw new ImageError('IMAGE_PROCESS_FAILED');}
  finally {active--;if(workdir)await rm(workdir,{recursive:true,force:true});}
}
function runNormalizer(workdir:string,format:ImageFormat,pixels:number,options:ImageNormalizerOptions):Promise<{width:number;height:number}>{
  return new Promise((resolveResult,reject)=>{
    const childEnv={...buildChildEnv(),NODE_ENV:process.env.NODE_ENV};
    const child=spawn(process.execPath,[options.scriptPath??resolve('scripts/normalize-image.mjs'),format,String(pixels)],{cwd:workdir,env:childEnv,stdio:['ignore','pipe','ignore'],detached:true,shell:false});
    let stdout='';let failure:ImageError|null=null;let settled=false;
    const finish=(error:ImageError|null)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(forceTimer);clearInterval(rssTimer);if(error){reject(error);return;}
      try{const result=processResult.parse(JSON.parse(stdout));if('error' in result)reject(new ImageError(result.error));else resolveResult(result);}catch{reject(new ImageError('IMAGE_PROCESS_FAILED'));}};
    const stop=(error:ImageError)=>{if(failure||settled)return;failure=error;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}forceTimer=setTimeout(()=>finish(error),2000);};
    let forceTimer:NodeJS.Timeout|undefined;
    const timer=setTimeout(()=>stop(new ImageError('IMAGE_PROCESS_TIMEOUT')),options.timeoutMs??30_000);
    const rssLimit=options.rssLimitMb??Math.max(1,Number(process.env.IMAGE_CHILD_RSS_LIMIT_MB)||1536);
    const rssTimer=setInterval(()=>{if(!child.pid||settled)return;void readFile(`/proc/${child.pid}/status`,'utf8').then(status=>{const kb=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0);if(kb>rssLimit*1024)stop(new ImageError('IMAGE_TOO_COMPLEX'));}).catch(()=>undefined);},100);
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{stdout+=chunk;if(stdout.length>4096)stop(new ImageError('IMAGE_PROCESS_FAILED'));});
    child.on('error',()=>finish(new ImageError('IMAGE_PROCESS_FAILED')));child.on('close',code=>finish(failure??(code===0?null:new ImageError('IMAGE_PROCESS_FAILED'))));
  });
}
