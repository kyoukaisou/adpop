// @vitest-environment node
//
// 🔴 画像の書き込みの**例外の経路**(Codex #7 Blocker 1 / 2)。
//   R2 に置いた後で、`head` が投げる・DB が投げる・`put` が投げる —— どの経路でも、**新しいキーが R2 に残らない**こと。
//   消せなかったら積み(`pending_image_deletions`)、次の操作で消し直すこと。
//   ⚠ 失敗はバインドを包んだ Proxy で作る(実物のローカル D1・R2 の上で、1つのメソッドだけを落とす)。
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import * as images from "../src/lib/data/images";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";
import { png } from "./helpers/images";
import { r2Snapshot } from "./helpers/r2";

let t: TestD1;
let variantId = "";
const IMAGE = { bytes: png(10, 10), contentType: "image/png", ext: "png" };

function failing<T extends object>(target: T, method: string, error = new Error(`${method} failed`)): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === method) return () => Promise.reject(error);
      const value = Reflect.get(obj, prop);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

const env = (overrides: { DB?: D1Database; IMAGES?: R2Bucket } = {}) => ({ DB: t.db, IMAGES: t.images, ...overrides });
const imageKeyOf = async () => {
  const v = await admin.getVariant(t.db, OWNER_A, variantId);
  return v.ok ? (v.value.content.imageKey as string | undefined) : undefined;
};

beforeAll(async () => {
  t = await openTestD1();
  await admin.ensureOwner(t.db, OWNER_A);
  const site = await admin.createSite(t.db, OWNER_A, { name: "s", allowedOrigins: [] });
  if (!site.ok) throw new Error("準備に失敗");
  const popup = await admin.createPopup(t.db, OWNER_A, site.value.id, { name: "p" });
  if (!popup.ok) throw new Error("準備に失敗");
  const variant = await admin.createVariant(t.db, OWNER_A, popup.value.id, {
    kind: "image",
    content: { headline: "", body: "", buttonLabel: "" },
    destinationUrl: "https://offer.example.com/",
  });
  if (!variant.ok) throw new Error("準備に失敗");
  variantId = variant.value.id;
  // 元の画像を1枚(失敗しても元の画像とキーが残ることを見る)
  const stored = await images.storeVariantImage(env(), OWNER_A, variantId, IMAGE);
  if (!stored.ok) throw new Error("準備に失敗");
});
afterAll(async () => {
  await t?.dispose();
});

describe("置いた後の例外で、新しいキーを残さない(Blocker 1)", () => {
  it.each([
    ["head が投げる", () => env({ IMAGES: failing(t.images, "head") })],
    ["DB への記録(batch)が投げる", () => env({ DB: failing(t.db, "batch") })],
    ["put が投げる", () => env({ IMAGES: failing(t.images, "put") })],
  ])("🔴 %s → 例外は呼び出し側へ・R2 の中身も元の画像のキーも変わらない", async (_label, makeEnv) => {
    const before = await r2Snapshot(t.images);
    const keyBefore = await imageKeyOf();
    await expect(images.storeVariantImage(makeEnv(), OWNER_A, variantId, IMAGE)).rejects.toThrow();
    expect(await r2Snapshot(t.images)).toEqual(before);
    expect(await imageKeyOf()).toBe(keyBefore);
  });

  it("🔴 DB が失敗を値で返した場合(他人のパターン)も、新しいキーを残さない", async () => {
    const before = await r2Snapshot(t.images);
    // 所有者の確認(getVariant)は通り、setVariantImage だけが「見つからない」を返す状況を作る
    const db = new Proxy(t.db, {
      get(obj, prop) {
        if (prop === "batch") {
          return async (statements: unknown[]) => {
            const results = await obj.batch(statements as never);
            return results.map((r, i) => (i === 1 ? { ...r, meta: { ...r.meta, changes: 0 } } : r));
          };
        }
        const value = Reflect.get(obj, prop);
        return typeof value === "function" ? value.bind(obj) : value;
      },
    });
    const keyBefore = await imageKeyOf();
    const result = await images.storeVariantImage(env({ DB: db }), OWNER_A, variantId, IMAGE);
    expect(result).toEqual({ ok: false, failure: { kind: "not_found" } });
    // ⚠ batch は実際には書いている(Proxy が結果だけを書き換える)ので、元のキーに戻す
    await admin.setVariantImage(t.db, OWNER_A, variantId, keyBefore ?? null);
    expect((await r2Snapshot(t.images)).map((e) => e.key)).toEqual(before.map((e) => e.key));
  });

  it("🔴 新しいキーを消すことにも失敗したら、積んでおき、次の操作で消す", async () => {
    // put と head は通り、batch(DB の記録)と delete(後始末)が落ちる
    const before = await r2Snapshot(t.images);
    await expect(
      images.storeVariantImage(env({ DB: failing(t.db, "batch"), IMAGES: failing(t.images, "delete") }), OWNER_A, variantId, IMAGE),
    ).rejects.toThrow();
    const after = await r2Snapshot(t.images);
    expect(after.length, "前提: 新しいキーが消せずに残った").toBe(before.length + 1);
    const pending = await t.db.prepare("select key from pending_image_deletions where owner_id = ?1").bind(OWNER_A).all<{ key: string }>();
    expect(pending.results.length).toBe(1);
    expect(await images.retryPendingImageDeletions(env(), OWNER_A)).toEqual({ ok: true, value: { deleted: 1, remaining: 0 } });
    expect(await r2Snapshot(t.images)).toEqual(before);
  });
});

describe("前の画像を消せなかったとき(Blocker 2)", () => {
  it("🔴 差し替えで前の画像を消せなければ、積んで cleanupPending に数が載る", async () => {
    const previous = await imageKeyOf();
    const result = await images.storeVariantImage(env({ IMAGES: failing(t.images, "delete") }), OWNER_A, variantId, IMAGE);
    expect(result.ok && result.value.cleanupPending).toBe(1);
    expect(await t.images.head(previous!), "前提: 前の画像が残っている").not.toBeNull();
    const removed = await images.removeVariantImage(env(), OWNER_A, variantId);
    expect(removed).toEqual({ ok: true, value: { cleanupPending: 0 } });
    expect(await t.images.head(previous!), "消し直されていない").toBeNull();
  });
});
