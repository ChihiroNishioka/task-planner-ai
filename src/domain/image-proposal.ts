import { z } from 'zod';
import { taskInputSchema } from './task';

export type ImageFormat = 'JPEG' | 'PNG' | 'HEIC';
export type ImageSource = { bytes: Buffer; mime: string; name: string };
export type ImageErrorCode = 'IMAGE_TOO_LARGE' | 'IMAGE_UNSUPPORTED' | 'IMAGE_MISMATCH' | 'IMAGE_CORRUPT' | 'IMAGE_PIXELS_TOO_LARGE' | 'IMAGE_TOO_COMPLEX' | 'HEIC_CONVERT_FAILED' | 'IMAGE_PROCESS_TIMEOUT' | 'IMAGE_PROCESS_FAILED' | 'IMAGE_BUSY' | 'IMAGE_REQUIRED' | 'INVALID_INPUT' | 'KEY_REUSED' | 'PROPOSAL_NOT_READY' | 'PROPOSAL_CREATING' | 'PROPOSAL_ALREADY_CONFIRMED' | 'PROPOSAL_EXPIRED' | 'NOT_FOUND';
const errors: Record<ImageErrorCode, [number,string]> = {
  IMAGE_TOO_LARGE:[413,'画像は10MiB以下にしてください。'], IMAGE_UNSUPPORTED:[415,'対応していない形式です。JPEG、PNG、HEIC、HEIFの画像を選んでください。'],
  IMAGE_MISMATCH:[422,'ファイル形式と内容が一致しません。'], IMAGE_CORRUPT:[422,'画像を読み取れませんでした。ファイルが壊れている可能性があります。'],
  IMAGE_PIXELS_TOO_LARGE:[422,'画像の画素数が大きすぎます。5,000万画素までにしてください。'], IMAGE_TOO_COMPLEX:[422,'画像を処理できる大きさにできませんでした。別の画像を選んでください。'],
  HEIC_CONVERT_FAILED:[422,'HEICの画像を変換できませんでした。JPEGやスクリーンショットで選び直してください。'], IMAGE_PROCESS_TIMEOUT:[503,'画像の処理に時間がかかりすぎました。小さい画像でお試しください。'],
  IMAGE_PROCESS_FAILED:[500,'画像を処理できませんでした。もう一度お試しください。'], IMAGE_BUSY:[429,'読み取りが混み合っています。少し待ってからもう一度お試しください。'],
  IMAGE_REQUIRED:[422,'画像を1枚選んでください。'], INVALID_INPUT:[422,'入力を確認してください。'], KEY_REUSED:[409,'この操作キーは別の内容に使われています。'],
  PROPOSAL_NOT_READY:[409,'読み取りがまだ終わっていません。'], PROPOSAL_CREATING:[409,'タスクを作成しています。少し待ってください。'],
  PROPOSAL_ALREADY_CONFIRMED:[409,'この提案はすでに別の内容で作成を受け付けています。'], PROPOSAL_EXPIRED:[410,'提案の有効期限が切れました。もう一度画像を選んでください。'],
  NOT_FOUND:[404,'提案が見つかりません。もう一度画像を選んでください。'],
};
export class ImageError extends Error {
  readonly status: number;
  constructor(readonly code: ImageErrorCode) { super(errors[code][1]); this.name = 'ImageError'; this.status=errors[code][0]; }
}
export function validImageDate(value: string | null): string | null { return value !== null && z.string().date().safeParse(value).success ? value : null; }
export const suggestionSchema = z.object({
  title:z.string().max(120).nullable(), deadline:z.string().nullable().transform(validImageDate), description:z.string().max(2000),
  extractedText:z.string().max(8000).nullable(), noTaskFound:z.boolean(),
}).strict();
export const confirmedImageSchema = z.object({
  title:taskInputSchema.shape.title, deadline:taskInputSchema.shape.deadline, description:z.string().max(2000).default(''),
  note:z.string().max(2000).default(''), extractedText:z.string().max(8000).nullable().default(null),
}).strict();
export type ImageSuggestion = z.infer<typeof suggestionSchema>;
export type ConfirmedImage = z.infer<typeof confirmedImageSchema>;
const heicBrands=new Set(['heic','heix','hevc','hevx','heim','heis']);
export function detectImageFormat({bytes,mime,name}:ImageSource):ImageFormat {
  if(bytes.length>10*1024*1024)throw new ImageError('IMAGE_TOO_LARGE');
  const types:Record<string,ImageFormat>={'image/jpeg':'JPEG','image/jpg':'JPEG','image/png':'PNG','image/heic':'HEIC','image/heif':'HEIC'};
  const extensions:Record<string,ImageFormat>={jpg:'JPEG',jpeg:'JPEG',png:'PNG',heic:'HEIC',heif:'HEIC'};
  const declared=(!mime||mime==='application/octet-stream')?extensions[name.toLowerCase().split('.').pop()??'']:types[mime.toLowerCase()];
  if(!declared)throw new ImageError('IMAGE_UNSUPPORTED');
  let actual:ImageFormat|undefined;
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)actual='JPEG';
  else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))actual='PNG';
  else if(bytes.subarray(4,8).toString()==='ftyp'){
    const major=bytes.subarray(8,12).toString();const brands:string[]=[];
    const end=Math.min(bytes.length,Math.max(16,bytes.readUInt32BE(0)));
    for(let offset=16;offset+4<=end;offset+=4)brands.push(bytes.subarray(offset,offset+4).toString());
    if(['avif','avis'].includes(major)||(brands.some(b=>['avif','avis'].includes(b))&&!brands.some(b=>heicBrands.has(b))&&!heicBrands.has(major)))throw new ImageError('IMAGE_UNSUPPORTED');
    if(heicBrands.has(major)||['mif1','msf1'].includes(major))actual='HEIC';
  }
  if(actual!==declared)throw new ImageError('IMAGE_MISMATCH');
  return actual;
}
export function safeImageName(name:string):string {
  const base=Array.from(name.split(/[\\/]/).pop()??'').filter(character=>{const code=character.charCodeAt(0);return code>31&&(code<127||code>159);}).join('');
  const stem=base.replace(/\.[^.]*$/,'').slice(0,200).trim();return `${stem||'image'}.jpg`;
}
export function mockImageSuggestion({name,note}:{name:string;note:string}):ImageSuggestion {
  const stem=safeImageName(name).slice(0,-4);const match=`${stem}\n${note}`.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
  return {title:note.split(/\r?\n/)[0].trim().slice(0,60)||`画像「${stem}」を確認する`,deadline:match?validImageDate(`${match[1]}-${match[2]}-${match[3]}`):null,description:'',extractedText:null,noTaskFound:false};
}
