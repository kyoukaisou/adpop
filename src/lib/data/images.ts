/*
  画像(R2)のデータ層。**R2 に触るのはここだけ**(`tests/d1-access-boundary.test.ts` が R2 の型も見る)。

  🔴 置き場のキーは `images/<16 バイトの乱数の16進>.<拡張子>`(内部 id・所有者を URL に出さない)。
  🔴 **「置けた」を成功にしない**: 置いた後 `head` で大きさを確かめる。DB への記録に失敗したら、置いた画像を消す。
  🔴 **所有者の分離**: 画像を書く・消す前に、そのパターン(またはサイト・ポップ)が呼び出し側の所有者のものかを
    データ層の関数(`admin.ts`)で確かめる。
  ⚠ R2 のバインドは「読むだけ」に絞れない(wrangler の設定項目に無い)。配信の Worker は読むだけの
    `image-read.ts` を使い、**このファイル(書き込み)を import しない**(tests/delivery-imports.test.ts)。
*/
import * as admin from "./admin";
import { isImageKey } from "./shapes";
import { resolveImages, type Bindings } from "./source";

export type ImageResult<T> = admin.Result<T>;

function newImageKey(ext: string): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `images/${hex}.${ext}`;
}

export type StoredImage = { key: string; previousKeyDeleted: boolean | null };

/**
 * パターンに画像を付ける(前の画像は R2 から消す)。
 * @param image 形式の判定と大きさの検査を**済ませた**バイト列(`src/lib/storage/image.ts`)
 */
export async function storeVariantImage(
  env: Bindings,
  ownerId: string,
  variantId: string,
  image: { bytes: Uint8Array; contentType: string; ext: string },
): Promise<ImageResult<StoredImage>> {
  const owned = await admin.getVariant(env, ownerId, variantId);
  if (!owned.ok) return owned;
  const bucket = resolveImages(env);
  const key = newImageKey(image.ext);
  await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
  const head = await bucket.head(key);
  if (head === null || head.size !== image.bytes.byteLength) {
    await bucket.delete(key);
    throw new Error("image verification failed after put");
  }
  const written = await admin.setVariantImage(env, ownerId, variantId, key);
  if (!written.ok) {
    await bucket.delete(key);
    return written;
  }
  let previousKeyDeleted: boolean | null = null;
  if (written.value.previousKey !== null && written.value.previousKey !== key) {
    previousKeyDeleted = await deleteQuietly(env, [written.value.previousKey]).then((failed) => failed === 0);
  }
  return { ok: true, value: { key, previousKeyDeleted } };
}

/** 画像を外す(DB のキーを消し、R2 からも消す)。 */
export async function removeVariantImage(
  env: Bindings,
  ownerId: string,
  variantId: string,
): Promise<ImageResult<{ previousKeyDeleted: boolean | null }>> {
  const written = await admin.setVariantImage(env, ownerId, variantId, null);
  if (!written.ok) return written;
  if (written.value.previousKey === null) return { ok: true, value: { previousKeyDeleted: null } };
  const failed = await deleteQuietly(env, [written.value.previousKey]);
  return { ok: true, value: { previousKeyDeleted: failed === 0 } };
}

/** 消す。⚠ 失敗しても投げない(呼び出し側は既に本体を消している)。**失敗した数**を返す。 */
async function deleteQuietly(env: Bindings, keys: string[]): Promise<number> {
  const valid = keys.filter(isImageKey);
  let failed = keys.length - valid.length;
  for (const key of valid) {
    try {
      await resolveImages(env).delete(key);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/*
  ─────────────── 削除(配下の画像も消す = security 監査 L2) ───────────────
  ⚠ 順序: ①所有者の条件つきでキーを集める ②行を消す ③R2 から消す。
    ③が失敗すると画像は残る(キーは推測できない乱数だが、知っていれば取れる)。失敗の数を返す。
*/
export type DeletedWithImages = { imagesLeft: number };

export async function deleteSiteWithImages(
  env: Bindings,
  ownerId: string,
  siteId: string,
): Promise<ImageResult<DeletedWithImages>> {
  const keys = await admin.imageKeysUnder(env, ownerId, { siteId });
  if (!keys.ok) return keys;
  const deleted = await admin.deleteSite(env, ownerId, siteId);
  if (!deleted.ok) return deleted;
  return { ok: true, value: { imagesLeft: await deleteQuietly(env, keys.value) } };
}

export async function deletePopupWithImages(
  env: Bindings,
  ownerId: string,
  popupId: string,
): Promise<ImageResult<DeletedWithImages>> {
  const keys = await admin.imageKeysUnder(env, ownerId, { popupId });
  if (!keys.ok) return keys;
  const deleted = await admin.deletePopup(env, ownerId, popupId);
  if (!deleted.ok) return deleted;
  return { ok: true, value: { imagesLeft: await deleteQuietly(env, keys.value) } };
}

export async function deleteVariantWithImages(
  env: Bindings,
  ownerId: string,
  variantId: string,
): Promise<ImageResult<DeletedWithImages>> {
  const keys = await admin.imageKeysUnder(env, ownerId, { variantId });
  if (!keys.ok) return keys;
  const deleted = await admin.deleteVariant(env, ownerId, variantId);
  if (!deleted.ok) return deleted;
  return { ok: true, value: { imagesLeft: await deleteQuietly(env, keys.value) } };
}
