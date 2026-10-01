/*
  画像(R2)のデータ層。**R2 に触るのはここだけ**(`tests/d1-access-boundary.test.ts` が R2 の型も見る)。

  🔴 置き場のキーは `images/<16 バイトの乱数の16進>.<拡張子>`(内部 id・所有者を URL に出さない)。
  🔴 **「置けた」を成功にしない**: 置いた後 `head` で大きさを確かめる。
  🔴 **DB への記録が完了しなかったら、新しいキーを消しにいく**(失敗の値でも、put / head / DB の例外でも = Codex #7 Blocker 1)。
    消せなければ積む。⚠ Worker そのものが途中で止まった(時間切れ等)場合は、消しにいけない。
  🔴 **R2 から消せなかったキーは捨てずに積む**(`pending_image_deletions`)。同じ所有者の次の画像の操作
    (アップロード・外す・削除)のたびに消し直す(Codex #7 Blocker 2)。積んでいる数は応答で返す(`cleanupPending`)。
    ⚠ 消し直すまでの間は、キーを知っていれば配信の /img から取れる(キーは推測できない乱数)。
  🔴 **所有者の分離**: 画像を書く・消す前に、そのパターン(またはサイト・ポップ)が呼び出し側の所有者のものかを
    データ層の関数(`admin.ts`)で確かめる。積んだキーも所有者の条件つきで扱う。
  ⚠ R2 のバインドは「読むだけ」に絞れない(wrangler の設定項目に無い)。配信の Worker は読むだけの
    `image-read.ts` を使い、**このファイル(書き込み)を import しない**(tests/delivery-imports.test.ts)。
*/
import * as admin from "./admin";
import { isImageKey } from "./shapes";
import { resolveDb, resolveImages, type Bindings } from "./source";

export type ImageResult<T> = admin.Result<T>;

/** 1回の操作で消し直す積んだキーの上限(1回の要求の仕事を有限にする)。 */
export const RETRY_BATCH = 20;

function newImageKey(ext: string): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `images/${hex}.${ext}`;
}

/** 消せなかったキーを積む。⚠ 積むこと自体が失敗したら(DB に届かない等)、どうにもできないので投げずに諦める。 */
async function enqueue(env: Bindings, ownerId: string, keys: string[]): Promise<void> {
  const db = resolveDb(env);
  for (const key of keys.filter(isImageKey)) {
    try {
      await db.prepare(`insert into pending_image_deletions (key, owner_id) values (?1, ?2)`).bind(key, ownerId).run();
    } catch {
      /* 積めない = DB も落ちている。呼び出し側は既に別の失敗を扱っている */
    }
  }
}

/** 消す。消せなかったキーは積む。 */
async function deleteOrEnqueue(env: Bindings, ownerId: string, keys: string[]): Promise<void> {
  const failed: string[] = [];
  for (const key of keys.filter(isImageKey)) {
    try {
      await resolveImages(env).delete(key);
    } catch {
      failed.push(key);
    }
  }
  if (failed.length > 0) await enqueue(env, ownerId, failed);
}

async function pendingCount(env: Bindings, ownerId: string): Promise<number> {
  const row = await resolveDb(env)
    .prepare(`select count(*) as c from pending_image_deletions where owner_id = ?1`)
    .bind(ownerId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * 積んだキーを消し直す(所有者の分だけ・1回に {@link RETRY_BATCH} 件まで)。
 * 画像の操作の最初に呼ぶ。⚠ ここでの失敗は、その操作を止めない(次の操作でまた試す)。
 */
export async function retryPendingImageDeletions(
  env: Bindings,
  ownerId: string,
): Promise<ImageResult<{ deleted: number; remaining: number }>> {
  const db = resolveDb(env);
  const rows = await db
    .prepare(`select key from pending_image_deletions where owner_id = ?1 order by created_at, key limit ?2`)
    .bind(ownerId, RETRY_BATCH)
    .all<{ key: string }>();
  let deleted = 0;
  for (const { key } of rows.results) {
    try {
      if (isImageKey(key)) await resolveImages(env).delete(key);
      await db.prepare(`delete from pending_image_deletions where key = ?1 and owner_id = ?2`).bind(key, ownerId).run();
      deleted += 1;
    } catch {
      await db
        .prepare(`update pending_image_deletions set attempts = attempts + 1 where key = ?1 and owner_id = ?2`)
        .bind(key, ownerId)
        .run()
        .catch(() => {});
    }
  }
  return { ok: true, value: { deleted, remaining: await pendingCount(env, ownerId) } };
}

async function retryQuietly(env: Bindings, ownerId: string): Promise<void> {
  try {
    await retryPendingImageDeletions(env, ownerId);
  } catch {
    /* 次の操作でまた試す */
  }
}

export type ImageOutcome = {
  /** この所有者の、R2 から消せずに積んでいるキーの数(0 でなければ、消し直しを待っている画像がある) */
  cleanupPending: number;
};

export type StoredImage = ImageOutcome & { key: string };

/**
 * パターンに画像を付ける(前の画像は R2 から消す。消せなければ積む)。
 * @param image 形式・大きさ・寸法の検査を**済ませた**バイト列(`src/lib/storage/image.ts`)
 */
export async function storeVariantImage(
  env: Bindings,
  ownerId: string,
  variantId: string,
  image: { bytes: Uint8Array; contentType: string; ext: string },
): Promise<ImageResult<StoredImage>> {
  const owned = await admin.getVariant(env, ownerId, variantId);
  if (!owned.ok) return owned;
  await retryQuietly(env, ownerId);
  const bucket = resolveImages(env);
  const key = newImageKey(image.ext);
  let written: Awaited<ReturnType<typeof admin.setVariantImage>>;
  try {
    await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
    const head = await bucket.head(key);
    if (head === null || head.size !== image.bytes.byteLength) throw new Error("image verification failed after put");
    written = await admin.setVariantImage(env, ownerId, variantId, key);
  } catch (error) {
    // 🔴 置いたかもしれない新しいキーを消す(消せなければ積む)。元の例外はそのまま投げる
    await deleteOrEnqueue(env, ownerId, [key]);
    throw error;
  }
  if (!written.ok) {
    await deleteOrEnqueue(env, ownerId, [key]);
    return written;
  }
  if (written.value.previousKey !== null && written.value.previousKey !== key) {
    await deleteOrEnqueue(env, ownerId, [written.value.previousKey]);
  }
  return { ok: true, value: { key, cleanupPending: await pendingCount(env, ownerId) } };
}

/** 画像を外す(DB のキーを消し、R2 からも消す。消せなければ積む)。 */
export async function removeVariantImage(
  env: Bindings,
  ownerId: string,
  variantId: string,
): Promise<ImageResult<ImageOutcome>> {
  const written = await admin.setVariantImage(env, ownerId, variantId, null);
  if (!written.ok) return written;
  await retryQuietly(env, ownerId);
  if (written.value.previousKey !== null) await deleteOrEnqueue(env, ownerId, [written.value.previousKey]);
  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };
}

/*
  ─────────────── 削除(配下の画像も消す = security 監査 L2) ───────────────
  ⚠ 順序: ①所有者の条件つきでキーを集める ②行を消す ③R2 から消す(消せなければ積む)。
*/
async function deleteWithImages(
  env: Bindings,
  ownerId: string,
  scope: Parameters<typeof admin.imageKeysUnder>[2],
  run: () => Promise<admin.Result<null>>,
): Promise<ImageResult<ImageOutcome>> {
  const keys = await admin.imageKeysUnder(env, ownerId, scope);
  if (!keys.ok) return keys;
  const deleted = await run();
  if (!deleted.ok) return deleted;
  await retryQuietly(env, ownerId);
  await deleteOrEnqueue(env, ownerId, keys.value);
  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };
}

export function deleteSiteWithImages(env: Bindings, ownerId: string, siteId: string): Promise<ImageResult<ImageOutcome>> {
  return deleteWithImages(env, ownerId, { siteId }, () => admin.deleteSite(env, ownerId, siteId));
}

export function deletePopupWithImages(env: Bindings, ownerId: string, popupId: string): Promise<ImageResult<ImageOutcome>> {
  return deleteWithImages(env, ownerId, { popupId }, () => admin.deletePopup(env, ownerId, popupId));
}

export function deleteVariantWithImages(
  env: Bindings,
  ownerId: string,
  variantId: string,
): Promise<ImageResult<ImageOutcome>> {
  return deleteWithImages(env, ownerId, { variantId }, () => admin.deleteVariant(env, ownerId, variantId));
}
