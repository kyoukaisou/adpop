/*
  検査用の最小の画像(ヘッダだけ本物の形)。寸法を自由に指定できる。
  ⚠ 中身(画素)は正しくない。ここで測るのは「ヘッダから寸法を読む」「APP1 を落とす」まで。
*/
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

export function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([...ascii("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0, 0x3b]);
}

export const JPEG_APP0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
export const JPEG_APP1_EXIF = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
export const JPEG_SOS_TO_EOI = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];

export function jpegSof(width: number, height: number): number[] {
  return [0xff, 0xc0, 0x00, 0x0b, 0x08, ...be16(height), ...be16(width), 0x01, 0x01, 0x11, 0x00];
}

export function jpeg(width: number, height: number, segments: number[] = []): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segments, ...jpegSof(width, height), ...JPEG_SOS_TO_EOI]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const body = [...ascii("WEBP"), ...ascii(chunk), ...le24(payload.length), 0, ...payload];
  return Uint8Array.from([...ascii("RIFF"), ...le24(body.length), 0, ...body]);
}

export function webpVp8x(width: number, height: number): Uint8Array {
  return riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

export function webpVp8(width: number, height: number): Uint8Array {
  return riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)]);
}

export function webpVp8l(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return riff("VP8L", [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f, 0, 0, 0, 0, 0]);
}
