// @vitest-environment node
//
// 🔴 画像の書き込み・削除の**失敗の経路**(Codex #7 1巡目 Blocker 1・2 / 2巡目 Blocker = write-ahead)。
//   ・置いた後で `head` / DB / `put` が投げても、新しいキーが R2 に残らない
//   ・D1 の取引(batch)が落ちたら、参照も消し直し待ちの行も**一緒に巻き戻る**
//   ・R2 の削除が途中で止まっても、消し直し待ちの行が残り、次の消し直しで消える
//   ・サイトの削除で、**アーカイブ済みを含む**全部の画像が消し直し待ちに載る
//   ⚠ 失敗はバインドを包んだ Proxy で作る(実物のローカル D1・R2 の上で、1つのメソッドだけを落とす)。
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import * as images from "../src/lib/data/images";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";
import { png } from "./helpers/images";
import { r2Snapshot } from "./helpers/r2";

let t: TestD1;
const IMAGE = { bytes: png(10, 10), contentType: "image/png", ext: "png" };

function failing<T extends object>(target: T, method: string, after = 0): T {
  let calls = 0;
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === method) {
        return (...args: unknown[]) => {
          calls += 1;
          if (calls > after) return Promise.reject(new Error(`${method} failed`));
          return (Reflect.get(obj, prop) as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      const value = Reflect.get(obj, prop);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

const env = (overrides: { DB?: D1Database; IMAGES?: R2Bucket } = {}) => ({ DB: t.db, IMAGES: t.images, ...overrides });
const pending = async () =>
  (await t.db.prepare("select key from pending_image_deletions where owner_id = ?1 order by key").bind(OWNER_A).all<{ key: string }>()).results.map(
    (r) => r.key,
  );
const ageAllPending = () =>
  t.db.prepare("update pending_image_deletions set created_at = '2000-01-01T00:00:00.000Z' where owner_id = ?1").bind(OWNER_A).run();

async function newVariant(siteId: string, archived = false): Promise<string> {
  const popup = await admin.createPopup(t.db, OWNER_A, siteId, { name: "p" });
  if (!popup.ok) throw new Error("準備に失敗");
  const variant = await admin.createVariant(t.db, OWNER_A, popup.value.id, {
    kind: "image",
    content: { headline: "", body: "", buttonLabel: "" },
    destinationUrl: "https://offer.example.com/",
  });
  if (!variant.ok) throw new Error("準備に失敗");
  const stored = await images.storeVariantImage(env(), OWNER_A, variant.value.id, IMAGE);
  if (!stored.ok) throw new Error("準備に失敗");
  if (archived) await admin.archiveVariant(t.db, OWNER_A, variant.value.id);
  return variant.value.id;
}

async function newSite(): Promise<string> {
  const site = await admin.createSite(t.db, OWNER_A, { name: "s", allowedOrigins: [] });
  if (!site.ok) throw new Error("準備に失敗");
  return site.value.id;
}

async function snapshot() {
  return {
    r2: await r2Snapshot(t.images),
    pending: await pending(),
    refs: (await t.db.prepare("select id, content from variants order by id").all()).results,
  };
}

beforeAll(async () => {
  t = await openTestD1();
  await admin.ensureOwner(t.db, OWNER_A);
});
beforeEach(async () => {
  // 前の it が残した消し直し待ちを片付ける(各 it が自分の積んだ行だけを数えられるように)
  await ageAllPending();
  await images.retryPendingImageDeletions(env(), OWNER_A);
});
afterAll(async () => {
  await t?.dispose();
});

describe("置いた後の例外で、新しいキーを残さない", () => {
  it.each([
    ["head が投げる", () => env({ IMAGES: failing(t.images, "head") })],
    ["DB への記録(batch)が投げる", () => env({ DB: failing(t.db, "batch") })],
    ["put が投げる", () => env({ IMAGES: failing(t.images, "put") })],
  ])("🔴 %s → 例外は呼び出し側へ。R2・参照・消し直し待ちの行が全部元のまま", async (_label, makeEnv) => {
    const variantId = await newVariant(await newSite());
    const before = await snapshot();
    await expect(images.storeVariantImage(makeEnv(), OWNER_A, variantId, IMAGE)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("🔴 新しいキーを消すことにも失敗したら、消し直し待ちの行が残り、後で消える", async () => {
    const variantId = await newVariant(await newSite());
    const before = await r2Snapshot(t.images);
    await expect(
      images.storeVariantImage(env({ DB: failing(t.db, "batch"), IMAGES: failing(t.images, "delete") }), OWNER_A, variantId, IMAGE),
    ).rejects.toThrow();
    expect((await r2Snapshot(t.images)).length, "前提: 新しいキーが消せずに残った").toBe(before.length + 1);
    expect((await pending()).length, "消し直し待ちに載っていない").toBe(1);
    await ageAllPending();
    expect(await images.retryPendingImageDeletions(env(), OWNER_A)).toEqual({ ok: true, value: { remaining: 0 } });
    expect(await r2Snapshot(t.images)).toEqual(before);
  });
});

describe("先に積む(write-ahead)", () => {
  it("🔴 削除の取引(batch)が落ちたら、参照も消し直し待ちも変わらない(全部巻き戻る)", async () => {
    const siteId = await newSite();
    await newVariant(siteId);
    const before = await snapshot();
    await expect(images.deleteSiteWithImages(env({ DB: failing(t.db, "batch") }), OWNER_A, siteId)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("🔴 画像を外す取引が落ちたら、参照も消し直し待ちも変わらない", async () => {
    const variantId = await newVariant(await newSite());
    const before = await snapshot();
    await expect(images.removeVariantImage(env({ DB: failing(t.db, "batch") }), OWNER_A, variantId)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("🔴🔴 サイトの削除で、アーカイブ済みを含む全部の画像が消し直し待ちに載る(R2 から1枚も消せなくても)", async () => {
    const siteId = await newSite();
    await newVariant(siteId);
    await newVariant(siteId);
    await newVariant(siteId, true);
    const keysUnderSite = (await r2Snapshot(t.images)).map((e) => e.key);
    const result = await images.deleteSiteWithImages(env({ IMAGES: failing(t.images, "delete") }), OWNER_A, siteId);
    expect(result).toEqual({ ok: true, value: { cleanupPending: 3 } });
    const queued = await pending();
    expect(queued.length).toBe(3);
    for (const key of queued) expect(keysUnderSite).toContain(key);
  });

  it("🔴 R2 の削除が途中で止まっても、残りは消し直し待ちに残り、次の消し直しで消える", async () => {
    const siteId = await newSite();
    await newVariant(siteId);
    await newVariant(siteId);
    await newVariant(siteId);
    const before = await r2Snapshot(t.images);
    // 1枚目だけ消せて、2枚目から落ちる
    const result = await images.deleteSiteWithImages(env({ IMAGES: failing(t.images, "delete", 1) }), OWNER_A, siteId);
    expect(result.ok && result.value.cleanupPending).toBe(2);
    expect((await r2Snapshot(t.images)).length).toBe(before.length - 1);
    // 積んでから時間が経つと、次の操作で消し直す
    await ageAllPending();
    expect(await images.retryPendingImageDeletions(env(), OWNER_A)).toEqual({ ok: true, value: { remaining: 0 } });
    expect((await r2Snapshot(t.images)).length).toBe(before.length - 3);
  });

  it("✅ 積んでから時間が経っていないキーは、ほかの操作が消し直さない(置いている途中のアップロードを消さない)", async () => {
    const variantId = await newVariant(await newSite());
    await images.removeVariantImage(env({ IMAGES: failing(t.images, "delete") }), OWNER_A, variantId);
    expect((await pending()).length).toBe(1);
    expect(await images.retryPendingImageDeletions(env(), OWNER_A)).toEqual({ ok: true, value: { remaining: 1 } });
  });

  it("🔴 まだ参照されているキーは、消し直し待ちに載っていても R2 から消さない(行だけ外す)", async () => {
    const variantId = await newVariant(await newSite());
    const variant = await admin.getVariant(t.db, OWNER_A, variantId);
    if (!variant.ok) throw new Error("準備に失敗");
    const live = variant.value.content.imageKey as string;
    await t.db
      .prepare("insert into pending_image_deletions (key, owner_id, created_at) values (?1, ?2, '2000-01-01T00:00:00.000Z')")
      .bind(live, OWNER_A)
      .run();
    await images.retryPendingImageDeletions(env(), OWNER_A);
    expect(await t.images.head(live), "参照中の画像を消した").not.toBeNull();
    expect(await pending()).toEqual([]);
  });
});
