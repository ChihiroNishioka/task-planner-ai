import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
export const GPS_SENTINEL = 'SYNTHETIC-GPS-SENTINEL';
export function syntheticPixels(width = 64, height = 40): Buffer {
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const color = y < height / 2 ? (x < width / 2 ? [240, 20, 20] : [20, 220, 20]) : (x < width / 2 ? [20, 20, 240] : [240, 220, 20]);
    bytes[offset] = color[0]; bytes[offset + 1] = color[1]; bytes[offset + 2] = color[2]; bytes[offset + 3] = 255;
  }
  return bytes;
}
export function syntheticJpeg({ width = 64, height = 40, orientation = 1, gps = false } = {}): Buffer {
  const encoded = jpeg.encode({ data: syntheticPixels(width, height), width, height }, 90).data;
  const tiff = Buffer.alloc(26);
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  const data = Buffer.concat([Buffer.from('Exif\0\0'), tiff, gps ? Buffer.from(GPS_SENTINEL) : Buffer.alloc(0)]);
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([encoded.subarray(0, 2), marker, data, encoded.subarray(2)]);
}
export function syntheticPng({ width = 64, height = 40, gps = false, byteLength }: { width?: number; height?: number; gps?: boolean; byteLength?: number } = {}): Buffer {
  const image=new PNG({width,height});image.data=syntheticPixels(width,height);
  const bytes = PNG.sync.write(image);
  const chunks = gps ? [pngChunk('eXIf', Buffer.from(GPS_SENTINEL)), pngChunk('tEXt', Buffer.from(`Comment\0${GPS_SENTINEL}`))] : [];
  if (byteLength !== undefined) {
    const paddingLength = byteLength - bytes.length - chunks.reduce((size, chunk) => size + chunk.length, 0) - 12;
    const keyword = Buffer.from('Padding\0');
    if (!Number.isSafeInteger(paddingLength) || paddingLength < keyword.length) throw new RangeError('PNGの指定サイズが小さすぎます。');
    chunks.push(pngChunk('tEXt', Buffer.concat([keyword, Buffer.alloc(paddingLength - keyword.length, 32)])));
  }
  return Buffer.concat([bytes.subarray(0,33), ...chunks, bytes.subarray(33)]);
}
function pngChunk(kind: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(kind,4);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from(kind),data])) { crc ^= byte; for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  const footer=Buffer.alloc(4);footer.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,data,footer]);
}
