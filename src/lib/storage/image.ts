/*
  アップロードされた画像を**中身で**判定する(副作用なし。Node でも Workers でも動く)。

  🔴 **ブラウザが名乗る Content-Type もファイル名も使わない。** 先頭のバイトで決める。
    置き場に付ける Content-Type もここで決めた値にする。
  🔴 **受け付けるのは PNG / JPEG / GIF / WebP だけ。** SVG は受けない(スクリプトを持てる)。
  🔴 **JPEG は APP1(Exif・XMP)を落としてから置く**(security 監査 L1: 撮影位置が全訪問者に配られる)。
    ⚠ 落とすのは JPEG の APP1 だけ。PNG の eXIf / tEXt、WebP の EXIF / XMP チャンクは落としていない(README)。
  🔴 **寸法の上限は長い辺 2,400px**(: ポップの表示の最大幅と、高い画素密度の画面での2倍を見込んだ値)。
    寸法はヘッダから読む(画像を展開しない)。**読めない画像は断る**(上限を確かめられないものを通さない)。
  ⚠ 大きさの上限は要件書 §4-3 の仮置き(画像 2MB・GIF 3MB)。
*/

export type ImageType = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; ext: "png" | "jpg" | "gif" | "webp" };

export const IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;
export const GIF_LIMIT_BYTES = 3 * 1024 * 1024;
/** 本文を読む上限(大きいほうの上限)。これを超えたら、中身を見る前に読むのをやめる。 */
export const MAX_UPLOAD_BYTES = GIF_LIMIT_BYTES;
/** 長い辺の上限(px)。 */
export const MAX_IMAGE_SIDE = 2400;
/** 画面に出す文言(画面の PR が使う)。⚠ 数字は MAX_IMAGE_SIDE と同じであること(検査が突き合わせる) */
export const IMAGE_TOO_LARGE_MESSAGE = "画像が大きすぎます(長い辺 2,400px まで)";

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { mime: "image/gif", ext: "gif" };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export type ImageCheck =
  | { ok: true; type: ImageType; bytes: Uint8Array; width: number; height: number }
  | { ok: false; reason: "empty" | "type" | "size" | "corrupt" | "dimensions" };

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/**
 * ヘッダから寸法を読む。読めなければ `null`(呼び出し側は断る)。
 * - PNG: IHDR(先頭のチャンク)/ GIF: 論理画面の幅と高さ / JPEG: SOFn / WebP: VP8・VP8L・VP8X
 */
export function readDimensions(bytes: Uint8Array, type: ImageType): { width: number; height: number } | null {
  const need = (n: number) => bytes.length >= n;
  switch (type.mime) {
    case "image/png":
      // 8 バイトの署名の後、IHDR が先頭(長さ 4 + "IHDR" 4 + 幅 4 + 高さ 4)
      if (!need(24) || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    case "image/gif":
      if (!need(10)) return null;
      return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
    case "image/webp": {
      if (!need(30)) return null;
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8 ") {
        if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
        return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
      }
      if (chunk === "VP8L") {
        if (bytes[20] !== 0x2f) return null;
        const [b0, b1, b2, b3] = [bytes[21], bytes[22], bytes[23], bytes[24]];
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === "VP8X") return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
      return null;
    }
    case "image/jpeg": {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        if (marker === 0xda || marker === 0xd9) return null; // SOF より先に画像データ = 読めない
        if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          i += 2;
          continue;
        }
        const length = u16be(bytes, i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { width: u16be(bytes, i + 7), height: u16be(bytes, i + 5) };
        if (length < 2) return null;
        i += 2 + length;
      }
      return null;
    }
  }
}

/**
 * JPEG の APP1 セグメント(Exif / XMP)を落とす。SOS(0xFFDA)より前のマーカーだけを歩く。
 * ⚠ 形が壊れていたら `null`(= 受け付けない)。黙って元のバイト列を返さない。
 */
export function stripJpegApp1(bytes: Uint8Array): Uint8Array | null {
  if (!startsWith(bytes, [0xff, 0xd8])) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === undefined) return null;
    // SOS 以降(画像データと EOI)はそのまま残す
    if (marker === 0xda) {
      parts.push(bytes.subarray(i));
      break;
    }
    // 長さを持たないマーカー(RSTn・TEM)
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) return null;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) return null;
    if (marker !== 0xe1) parts.push(bytes.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function checkImage(bytes: Uint8Array): ImageCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  const type = sniffImageType(bytes);
  if (type === null) return { ok: false, reason: "type" };
  const limit = type.mime === "image/gif" ? GIF_LIMIT_BYTES : IMAGE_LIMIT_BYTES;
  if (bytes.byteLength > limit) return { ok: false, reason: "size" };
  const size = readDimensions(bytes, type);
  if (size === null || size.width === 0 || size.height === 0) return { ok: false, reason: "corrupt" };
  if (Math.max(size.width, size.height) > MAX_IMAGE_SIDE) return { ok: false, reason: "dimensions" };
  if (type.mime === "image/jpeg") {
    const stripped = stripJpegApp1(bytes);
    if (stripped === null) return { ok: false, reason: "corrupt" };
    return { ok: true, type, bytes: stripped, ...size };
  }
  return { ok: true, type, bytes, ...size };
}
