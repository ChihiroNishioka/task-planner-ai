#!/usr/bin/env node
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;});
process.stdin.on('end',()=>{
  if(input.includes('FAKE_CLI_EXIT_1'))process.exit(1);
  process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({title:'合成画像のタスク',deadline:'2026-11-30',description:'合成画像からの提案',extractedText:'合成画像の読み取り結果',noTaskFound:false})})+'\n');
});
