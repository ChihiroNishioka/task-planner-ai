import { readFile, writeFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import decodeHeic from 'heic-decode';
import { inflateSync } from 'node:zlib';

const format=process.argv[2];
const headerPixels=Number(process.argv[3]);
function validatePngExpansion(bytes){
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),depth=bytes[24],channels=({0:1,2:3,3:1,4:2,6:4})[bytes[25]];
  if(!channels||![1,2,4,8,16].includes(depth)||width*height>50_000_000)throw new Error('IMAGE_CORRUPT');
  const passes=bytes[28]===1?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  let maximum=0;
  for(const [x,y,dx,dy] of passes){const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));if(w&&h)maximum+=(Math.ceil(w*channels*depth/8)+1)*h;}
  const chunks=[];
  for(let offset=8;offset+12<=bytes.length;){const length=bytes.readUInt32BE(offset);if(offset+length+12>bytes.length)throw new Error('IMAGE_CORRUPT');const type=bytes.subarray(offset+4,offset+8).toString();if(type==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+length));offset+=length+12;}
  const expanded=inflateSync(Buffer.concat(chunks),{maxOutputLength:maximum});if(expanded.length!==maximum)throw new Error('IMAGE_CORRUPT');
}
function orientation(bytes) {
  for(let offset=2;offset+4<bytes.length;){
    if(bytes[offset]!==255)break;
    const marker=bytes[offset+1];const length=bytes.readUInt16BE(offset+2);
    if(marker===0xda||marker===0xd9||length<2)break;
    if(marker===0xe1&&bytes.subarray(offset+4,offset+10).toString()==='Exif\0\0'){
      const start=offset+10;const little=bytes.subarray(start,start+2).toString()==='II';
      const short=pos=>little?bytes.readUInt16LE(pos):bytes.readUInt16BE(pos);
      const long=pos=>little?bytes.readUInt32LE(pos):bytes.readUInt32BE(pos);
      const directory=start+long(start+4);const entries=short(directory);
      for(let index=0;index<entries;index++){const at=directory+2+index*12;if(at+12>Math.min(bytes.length,offset+length+2))break;if(short(at)===0x112&&short(at+2)===3&&long(at+4)===1){const value=short(at+8);return value>=1&&value<=8?value:1;}}
    }
    offset+=length+2;
  }
  return 1;
}
function transform(image,rotation){
  const swap=rotation>=5;const width=swap?image.height:image.width;const height=swap?image.width:image.height;
  const scale=Math.min(1,3000/Math.max(width,height));const targetWidth=Math.max(1,Math.round(width*scale));const targetHeight=Math.max(1,Math.round(height*scale));
  const data=Buffer.alloc(targetWidth*targetHeight*4);
  for(let y=0;y<targetHeight;y++)for(let x=0;x<targetWidth;x++){
    const tx=Math.min(width-1,Math.floor(x/scale));const ty=Math.min(height-1,Math.floor(y/scale));
    let sx=tx,sy=ty;
    switch(rotation){case 2:sx=image.width-1-tx;break;case 3:sx=image.width-1-tx;sy=image.height-1-ty;break;case 4:sy=image.height-1-ty;break;case 5:sx=ty;sy=tx;break;case 6:sx=ty;sy=image.height-1-tx;break;case 7:sx=image.width-1-ty;sy=image.height-1-tx;break;case 8:sx=image.width-1-ty;sy=tx;break;}
    const source=(sy*image.width+sx)*4;const target=(y*targetWidth+x)*4;const alpha=image.data[source+3]/255;
    for(let channel=0;channel<3;channel++)data[target+channel]=Math.round(image.data[source+channel]*alpha+255*(1-alpha));data[target+3]=255;
  }
  return {width:targetWidth,height:targetHeight,data};
}
try {
  const bytes=await readFile('input');let image;
  if(format==='JPEG')image=jpeg.decode(bytes,{useTArray:true,maxResolutionInMP:50,maxMemoryUsageInMB:512,tolerantDecoding:false});
  else if(format==='PNG'){validatePngExpansion(bytes);image=PNG.sync.read(bytes,{checkCRC:true});}
  else if(format==='HEIC'){
    const compatible=Buffer.from(bytes);if(['heim','heis'].includes(compatible.subarray(8,12).toString()))compatible.write('heic',8);
    const originalLog=console.log;console.log=()=>undefined;
    try{image=await decodeHeic({buffer:compatible});}finally{console.log=originalLog;}
  }
  else throw new Error('IMAGE_CORRUPT');
  const pixels=image.width*image.height;
  if(!image.width||!image.height||!Number.isFinite(pixels))throw new Error(format==='HEIC'?'HEIC_CONVERT_FAILED':'IMAGE_CORRUPT');
  if(pixels>50_000_000)throw new Error('IMAGE_PIXELS_TOO_LARGE');
  if(format==='HEIC'&&pixels>headerPixels)throw new Error('HEIC_CONVERT_FAILED');
  const transformed=transform(image,format==='JPEG'?orientation(bytes):1);
  let encoded;
  for(const quality of [88,75,60]){encoded=jpeg.encode(transformed,quality).data;if(encoded.length<=3.5*1024*1024)break;}
  if(!encoded||encoded.length>3.5*1024*1024)throw new Error('IMAGE_TOO_COMPLEX');
  await writeFile('output.jpg',encoded,{mode:0o600});
  process.stdout.write(JSON.stringify({width:transformed.width,height:transformed.height})+'\n');
}catch(error){
  const message=error instanceof Error?error.message:'';
  const known=['IMAGE_PIXELS_TOO_LARGE','IMAGE_TOO_COMPLEX','HEIC_CONVERT_FAILED','IMAGE_CORRUPT'];
  const code=known.includes(message)?message:/maxResolutionInMP/.test(message)?'IMAGE_PIXELS_TOO_LARGE':/maxMemoryUsageInMB/.test(message)?'IMAGE_TOO_COMPLEX':format==='HEIC'?'HEIC_CONVERT_FAILED':'IMAGE_CORRUPT';
  process.stdout.write(JSON.stringify({error:code})+'\n');
}
