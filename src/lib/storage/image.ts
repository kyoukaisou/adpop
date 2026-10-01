/*
  アップロードされた画像を**中身で**判定する(副作用なし。Node でも Workers でも動く)。

  🔴 **ブラウザが名乗る Content-Type もファイル名も使わない。** 先頭のバイトで決める。
    置き場に付ける Content-Type もここで決めた値にする。
  🔴 **受け付けるのは PNG / JPEG / GIF / WebP だけ。** SVG は受けない(スクリプトを持てる)。
  🔴 **JPEG は APP1(Exif・XMP)を落としてから置く**(security 監査 L1: 撮影位置が全訪問者に配られる)。
    ⚠ 落とすのは JPEG の APP1 だけ。PNG の eXIf / tEXt、WebP の EXIF / XMP チャンクは落としていない(README)。
  ⚠ 寸法の上限は置いていない(要件書に数値が無い)。
  ⚠ 大きさの上限は要件書 §4-3 の仮置き(画像 2MB・GIF 3MB)。
*/

export type ImageType = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; ext: "png" | "jpg" | "gif" | "webp" };

export const IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;
export const GIF_LIMIT_BYTES = 3 * 1024 * 1024;
/** 本文を読む上限(大きいほうの上限)。これを超えたら、中身を見る前に読むのをやめる。 */
export const MAX_UPLOAD_BYTES = GIF_LIMIT_BYTES;

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
  | { ok: true; type: ImageType; bytes: Uint8Array }
  | { ok: false; reason: "empty" | "type" | "size" | "corrupt" };

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
  if (type.mime === "image/jpeg") {
    const stripped = stripJpegApp1(bytes);
    if (stripped === null) return { ok: false, reason: "corrupt" };
    return { ok: true, type, bytes: stripped };
  }
  return { ok: true, type, bytes };
}
