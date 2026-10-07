/*
  R2 の中身のスナップショット(キーだけでなく、**本文のバイト列と Content-Type** も = レビュー指摘)。
  同じキーの本文やメタデータを上書きする退行も、比べれば見つかる。
*/
import type { R2Bucket } from "@cloudflare/workers-types";

export type R2Entry = { key: string; size: number; contentType: string | null; bodyHex: string };

export async function r2Snapshot(bucket: R2Bucket): Promise<R2Entry[]> {
  const out: R2Entry[] = [];
  for (const { key } of (await bucket.list()).objects) {
    const object = await bucket.get(key);
    if (object === null) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    out.push({
      key,
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? null,
      bodyHex: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}
