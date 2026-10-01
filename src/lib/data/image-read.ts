/*
  画像を**読むだけ**(配信の Worker が使う)。書き込みの `images.ts` とは分けてある:
  配信の Worker の束に、書き込み・削除のコードを入れない(tests/delivery-imports.test.ts)。
*/
import { isImageKey } from "./shapes";
import { resolveImages, type Bindings } from "./source";

/** キーの形を確かめてから読む。無ければ `null`。 */
export async function readImage(
  env: Bindings,
  key: string,
): Promise<{ body: ReadableStream; contentType: string; size: number } | null> {
  if (!isImageKey(key)) return null;
  const object = await resolveImages(env).get(key);
  if (object === null) return null;
  return {
    body: object.body as unknown as ReadableStream,
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    size: object.size,
  };
}
