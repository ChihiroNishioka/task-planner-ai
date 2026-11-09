#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;});
process.stdin.on('end',()=>{
 if(process.argv.includes('--input-format')) {
  process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({title:'合成画像の候補',deadline:null,description:'',extractedText:'合成画像の本文',noTaskFound:false})})+'\n');return;
 }
 const gate=/IMAGE_TEST_GATE:([^\s]+)/.exec(input)?.[1];
 const finish=()=>process.stdout.write(JSON.stringify({steps:['合成の確認手順'],draftMarkdown:'# 合成ドラフト'}));
 if(!gate){finish();return;}
 writeFileSync(`${gate}.started`,'started');
 const timer=setInterval(()=>{if(existsSync(`${gate}.release`)){clearInterval(timer);finish();}},25);
});
