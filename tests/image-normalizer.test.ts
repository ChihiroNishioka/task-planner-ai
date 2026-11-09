import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { normalizeImage } from '../src/adapters/image-normalizer';
import { detectImageFormat, mockImageSuggestion, safeImageName } from '../src/domain/image-proposal';
import { GPS_SENTINEL, syntheticJpeg, syntheticPng } from './helpers/synthetic-images';

const directories: string[] = [];
function directory() { const value = mkdtempSync('/workspace/dev/tp-image-runs/image-normalizer-'); directories.push(value); return value; }
afterEach(() => { for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true }); });
function input(bytes: Buffer, mime = 'image/jpeg', name = 'synthetic.jpg') { return { bytes, mime, name }; }
function fixture(name: string) { return readFileSync(join(process.cwd(), 'tests/fixtures/images', name)); }
function emptyTemporaryFiles(root: string) { try { expect(readdirSync(join(root, 'tmp'))).toEqual([]); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; } }
describe('画像正規化', () => {
  it('E-10 用の10MiBちょうどのPNGはデコードと正規化に成功する', async () => {
    const source = syntheticPng({ byteLength: 10 * 1024 * 1024 });
    expect(source.length).toBe(10 * 1024 * 1024);
    expect(PNG.sync.read(source).data).toHaveLength(64 * 40 * 4);
    const result = await normalizeImage(input(source, 'image/png', 'synthetic-limit.png'), directory());
    expect([result.width, result.height, result.sourceFormat]).toEqual([64, 40, 'PNG']);
    expect(jpeg.decode(result.bytes).width).toBe(64);
  });
  it('U-01 JPEG の EXIF と GPS を除去する', async () => {
    const source = syntheticJpeg({ gps: true }); expect(source.includes(Buffer.from(GPS_SENTINEL))).toBe(true);
    const result = await normalizeImage(input(source), directory());
    expect(result.bytes.subarray(0, 3)).toEqual(Buffer.from([255,216,255]));
    expect(result.bytes.includes(Buffer.from(GPS_SENTINEL))).toBe(false); expect(result.bytes.includes(Buffer.from('Exif'))).toBe(false);
  });
  it('U-02 PNG の補助メタデータを除去し JPEG にする', async () => {
    const source = syntheticPng({ gps: true }); expect(source.includes(Buffer.from(GPS_SENTINEL))).toBe(true);
    const result = await normalizeImage(input(source, 'image/png', 'synthetic.png'), directory());
    expect(result.sourceFormat).toBe('PNG'); expect(result.bytes.includes(Buffer.from(GPS_SENTINEL))).toBe(false);
    expect(jpeg.decode(result.bytes).width).toBe(64);
  });
  it('U-03 HEIC を元の寸法で JPEG にする', async () => {
    const result = await normalizeImage(input(fixture('synthetic-plain.heic'), 'image/heic', 'synthetic.heic'), directory());
    expect([result.width, result.height, result.sourceFormat]).toEqual([64,40,'HEIC']); expect(jpeg.decode(result.bytes).width).toBe(64);
  });
  it('U-04 HEIC の GPS を除去する', async () => {
    const source = fixture('synthetic-gps.heic'); expect(source.includes(Buffer.from(GPS_SENTINEL))).toBe(true);
    const result = await normalizeImage(input(source, 'image/heic', 'synthetic.heic'), directory());
    expect(result.bytes.includes(Buffer.from(GPS_SENTINEL))).toBe(false);
  });
  it('U-05 壊れた HEIC を拒否し作業ファイルを消す', async () => {
    const root = directory(); const bytes = Buffer.from('0000ftypheic0000heic');
    await expect(normalizeImage(input(bytes, 'image/heic', 'broken.heic'), root)).rejects.toMatchObject({ code: 'HEIC_CONVERT_FAILED' }); emptyTemporaryFiles(root);
  });
  it('U-06 EXIF Orientation=6 を画素に適用する', async () => {
    const result = await normalizeImage(input(syntheticJpeg({ orientation: 6 })), directory());
    expect([result.width,result.height]).toEqual([40,64]);
    const decoded = jpeg.decode(result.bytes); expect(decoded.data[0]).toBeLessThan(65); expect(decoded.data[2]).toBeGreaterThan(180);
  });
  it('U-07 長辺 4000px を 3000px 以下に縮める', async () => {
    const result = await normalizeImage(input(syntheticJpeg({width:4000,height:40})), directory());
    expect([result.width,result.height]).toEqual([3000,30]); expect(result.bytes.length).toBeLessThanOrEqual(3.5*1024*1024);
  });
  it('U-08 PNG の IHDR の過大寸法をデコード前に拒否する', async () => {
    const bytes = syntheticPng(); bytes.writeUInt32BE(10_000,16); bytes.writeUInt32BE(6_000,20);
    await expect(normalizeImage(input(bytes,'image/png','huge.png'),directory())).rejects.toMatchObject({code:'IMAGE_PIXELS_TOO_LARGE'});
  });
  it.each([
    ['image/jpeg','a.jpg',Buffer.from([255,216,255]),'JPEG'],
    ['image/png','a.png',Buffer.from([137,80,78,71,13,10,26,10]),'PNG'],
    ['','a.heic',Buffer.from('0000ftypheic0000heic'),'HEIC'],
    ['application/octet-stream','a.heif',Buffer.from('0000ftypmif10000heic'),'HEIC'],
  ])('U-09 形式一致 %s %s', (mime,name,bytes,format) => expect(detectImageFormat(input(bytes,mime,name))).toBe(format));
  it.each([
    ['image/heic','a.heic',Buffer.from([255,216,255]),'IMAGE_MISMATCH'],
    ['image/heic','a.heic',Buffer.from('0000ftypavif0000avif'),'IMAGE_UNSUPPORTED'],
    ['image/gif','a.gif',Buffer.from('GIF89a'),'IMAGE_UNSUPPORTED'],
  ])('U-09 不一致・非対応 %s %s', (mime,name,bytes,code) => expect(() => detectImageFormat(input(bytes,mime,name))).toThrowError(expect.objectContaining({code})));
  it('U-10 切れた JPEG は IMAGE_CORRUPT', async () => {
    await expect(normalizeImage(input(syntheticJpeg().subarray(0,45)),directory())).rejects.toMatchObject({code:'IMAGE_CORRUPT'});
  });
  it('U-11 終わらない子プロセスを終了し作業ファイルを消す', async () => {
    const root=directory(); const scriptPath=join(root,'hang.mjs'); writeFileSync(scriptPath,'setInterval(() => {}, 1000);');
    await expect(normalizeImage(input(syntheticJpeg()),root,{scriptPath,timeoutMs:150})).rejects.toMatchObject({code:'IMAGE_PROCESS_TIMEOUT'}); emptyTemporaryFiles(root);
  });
  it.each([['../../x\\y.heic','y.jpg'],['\u0000a\n.png','a.jpg'],['','image.jpg']])('U-12 表示名を安全にする %s', (name,expected) => expect(safeImageName(name)).toBe(expected));
  it('U-13 過大 SOF を持つ JPEG ヘッダーを拒否する', async () => {
    const bytes=Buffer.from([255,216,255,192,0,11,8,0x17,0x70,0x27,0x10,1,1,0x11,0]);
    await expect(normalizeImage(input(bytes),directory())).rejects.toMatchObject({code:'IMAGE_PIXELS_TOO_LARGE'});
  });
  it('U-14 後続の過大 SOF をデコーダの上限で拒否する', async () => {
    const bytes=syntheticJpeg(); const sof=bytes.indexOf(Buffer.from([255,192])); const oversized=Buffer.from(bytes.subarray(sof,sof+19)); oversized.writeUInt16BE(6000,5); oversized.writeUInt16BE(10000,7);
    await expect(normalizeImage(input(Buffer.concat([bytes.subarray(0,sof+19),oversized,bytes.subarray(sof+19)])),directory())).rejects.toMatchObject({code:'IMAGE_PIXELS_TOO_LARGE'});
  });
  it.each([[10000,6000,'IMAGE_PIXELS_TOO_LARGE'],[1,1,'HEIC_CONVERT_FAILED']])('U-15 HEIC ispe 寸法 %i x %i を検証する',async(width,height,code)=>{
    const bytes=fixture('synthetic-plain.heic'); let start=bytes.indexOf(Buffer.from('ispe')); while(start>=0){bytes.writeUInt32BE(width,start+8);bytes.writeUInt32BE(height,start+12);start=bytes.indexOf(Buffer.from('ispe'),start+4);}
    await expect(normalizeImage(input(bytes,'image/heic','synthetic.heic'),directory())).rejects.toMatchObject({code});
  });
  it.each(['process.exit(7)','process.kill(process.pid,"SIGKILL")','process.stdout.write("not-json")'])('U-16 子プロセス異常を拒否し削除する %s',async(script)=>{
    const root=directory();const scriptPath=join(root,'bad.mjs');writeFileSync(scriptPath,script);
    await expect(normalizeImage(input(syntheticJpeg()),root,{scriptPath})).rejects.toMatchObject({code:'IMAGE_PROCESS_FAILED'});emptyTemporaryFiles(root);
  });
  it('U-16 RSS 上限を超えた子プロセスを停止する',async()=>{
    const root=directory();const scriptPath=join(root,'memory.mjs');writeFileSync(scriptPath,'const a=[];setInterval(()=>a.push(Buffer.alloc(16*1024*1024,255)),5);');
    await expect(normalizeImage(input(syntheticJpeg()),root,{scriptPath,rssLimitMb:64})).rejects.toMatchObject({code:'IMAGE_TOO_COMPLEX'});emptyTemporaryFiles(root);
  });
  it.each([
    {name:'synthetic-irot.heic',marker:'irot',width:40,height:64,colors:[[20,220,20],[240,220,20],[240,20,20],[20,20,240]]},
    {name:'synthetic-imir.heic',marker:'imir',width:64,height:40,colors:[[20,220,20],[240,20,20],[240,220,20],[20,20,240]]},
  ])('U-17 HEIC の $marker の向きを適用する',async({name,marker,width,height,colors})=>{
    const bytes=fixture(name);expect(bytes.includes(Buffer.from(marker))).toBe(true);
    const result=await normalizeImage(input(bytes,'image/heic',name),directory());expect([result.width,result.height]).toEqual([width,height]);
    const decoded=jpeg.decode(result.bytes);const positions=[[3,3],[width-4,3],[3,height-4],[width-4,height-4]];
    for(let corner=0;corner<4;corner++){const [x,y]=positions[corner];for(let channel=0;channel<3;channel++)expect(Math.abs(decoded.data[(y*width+x)*4+channel]-colors[corner][channel])).toBeLessThan(60);}
  });
  it('U-25 mock は決定的で日付とメモを使う',()=>{
    const value={name:'synthetic_2026-12-25.png',note:'確認する\n補足'};const result=mockImageSuggestion(value);
    expect(result).toEqual(mockImageSuggestion(value));expect(result).toMatchObject({title:'確認する',deadline:'2026-12-25',extractedText:null,noTaskFound:false});
    expect(mockImageSuggestion({name:'2026-02-30.jpg',note:''}).deadline).toBeNull();
  });
});
