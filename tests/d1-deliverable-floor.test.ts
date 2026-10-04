// @vitest-environment node
//
// 🔴 稼働中のポップから「配信できる最後のパターン」を奪う操作を断る(Codex #8 1巡目 Blocker 1・本部裁定)。
//   対象の4操作: 画像を外す(setVariantImage null) / 唯一のtext型を画像の無いimage型に変える(updateVariant) /
//   アーカイブする(archiveVariant) / 削除する(deleteVariant)。
//   🔴 黙って停止に切り替えるのではなく、操作そのものを 409(`last_deliverable_variant`)で断る。
//   🔴 判定は書き込みと同じ1つの文の WHERE(条件つきの書き込み)で行う。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

const BLOCKED = { ok: false, failure: { kind: "last_deliverable_variant" } };
const IMAGE_KEY = (hex: string) => `images/${hex.repeat(32)}.png`;

async function newActiveSite(): Promise<string> {
  return value(await admin.createSite(db, OWNER_A, { name: "floor", allowedOrigins: [] })).id;
}

const textInput = (headline: string): admin.VariantInput => ({
  kind: "text",
  content: { headline, body: "", buttonLabel: "", imageAlt: "" },
  destinationUrl: "https://offer.example.com/",
});
const imageInput = (): admin.VariantInput => ({
  kind: "image",
  content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明" },
  destinationUrl: "https://offer.example.com/",
});

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  await admin.ensureOwner(db, OWNER_A);
});
afterAll(async () => {
  await t?.dispose();
});

describe("稼働中のポップから最後の配信可能パターンを奪う操作を断る", () => {
  it("🔴 画像を外す(setVariantImage null)— 唯一の画像パターンから画像を外すと断られ、imageKey は残る", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await admin.setVariantImage(db, OWNER_A, variantId, IMAGE_KEY("a")));
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect(await admin.setVariantImage(db, OWNER_A, variantId, null)).toEqual(BLOCKED);
    // ⚠ 断られたら imageKey は変わらず残る(操作前後で状態が変わらない)
    const after = value(await admin.getVariant(db, OWNER_A, variantId));
    expect(after.content.imageKey).toBe(IMAGE_KEY("a"));
  });

  it("✅ ただし他にも配信できるパターンがあれば、画像を外せる", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const imageVariant = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    value(await admin.setVariantImage(db, OWNER_A, imageVariant, IMAGE_KEY("b")));
    value(await admin.createVariant(db, OWNER_A, popupId, textInput("もう1つ"))); // text型は常に配信できる
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect(await admin.setVariantImage(db, OWNER_A, imageVariant, null)).toEqual({
      ok: true,
      value: { previousKey: IMAGE_KEY("b") },
    });
  });

  it("✅ text型のパターンの imageKey を外すのは、唯一の稼働中パターンでも断られない(配信できる状態を減らさない)", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("唯一"))).id;
    // text型にも imageKey を置ける(配信判定では使われない残骸だが、API としては許されている)
    value(await admin.setVariantImage(db, OWNER_A, variantId, IMAGE_KEY("d")));
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect(await admin.setVariantImage(db, OWNER_A, variantId, null)).toEqual({
      ok: true,
      value: { previousKey: IMAGE_KEY("d") },
    });
  });

  it("🔴 唯一のtext型を、画像の無い画像型へ編集する(updateVariant)— 断られ、kindは変わらない", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("唯一"))).id;
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect(await admin.updateVariant(db, OWNER_A, variantId, imageInput())).toEqual(BLOCKED);
    const after = value(await admin.getVariant(db, OWNER_A, variantId));
    expect(after.kind).toBe("text");
  });

  it("✅ ただし変えた後も配信できるなら通る(例: 画像型だが既に imageKey を持っている)", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("唯一"))).id;
    value(await admin.setVariantImage(db, OWNER_A, variantId, IMAGE_KEY("c")));
    value(await admin.activatePopup(db, OWNER_A, popupId));

    // text → image だが、既に imageKey を持っているので配信できるまま。断られない
    expect((await admin.updateVariant(db, OWNER_A, variantId, imageInput())).ok).toBe(true);
    const after = value(await admin.getVariant(db, OWNER_A, variantId));
    expect(after.kind).toBe("image");
    expect(after.content.imageKey).toBe(IMAGE_KEY("c"));
  });

  it("🔴 アーカイブする(archiveVariant)— 唯一の配信可能パターンのアーカイブは断られる", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("唯一"))).id;
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect(await admin.archiveVariant(db, OWNER_A, variantId)).toEqual(BLOCKED);
    const after = value(await admin.getVariant(db, OWNER_A, variantId));
    expect(after.archivedAt).toBeNull();
  });

  it("✅ 他に配信できるパターンがあればアーカイブできる", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("消す方"))).id;
    value(await admin.createVariant(db, OWNER_A, popupId, textInput("残る方")));
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect((await admin.archiveVariant(db, OWNER_A, variantId)).ok).toBe(true);
  });

  it("🔴 削除する(deleteVariant)— 唯一の配信可能パターンの削除は断られ、行は残る", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("唯一"))).id;
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect(await admin.deleteVariant(db, OWNER_A, variantId)).toEqual(BLOCKED);
    expect((await admin.getVariant(db, OWNER_A, variantId)).ok).toBe(true);
  });

  it("🔴 断られた削除では、画像キーが pending_image_deletions に積まれない(Codex #8 2巡目 Should fix)", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
    const key = IMAGE_KEY("f");
    value(await admin.setVariantImage(db, OWNER_A, variantId, key));
    value(await admin.activatePopup(db, OWNER_A, popupId));

    const pendingBefore = await db
      .prepare("select count(*) as c from pending_image_deletions where key = ?1")
      .bind(key)
      .first<{ c: number }>();
    expect(pendingBefore?.c, "前提: まだ積まれていない").toBe(0);

    expect(await admin.deleteVariant(db, OWNER_A, variantId)).toEqual(BLOCKED);

    // ⚠ 削除は断られたので、行も画像の参照も変わらず、消し直し待ちにも積まれていない
    expect((await admin.getVariant(db, OWNER_A, variantId)).ok).toBe(true);
    const pendingAfter = await db
      .prepare("select count(*) as c from pending_image_deletions where key = ?1")
      .bind(key)
      .first<{ c: number }>();
    expect(pendingAfter?.c, "断られたのに pending_image_deletions に積まれた").toBe(0);
  });

  it("✅ 他に配信できるパターンがあれば削除できる", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("消す方"))).id;
    value(await admin.createVariant(db, OWNER_A, popupId, textInput("残る方")));
    value(await admin.activatePopup(db, OWNER_A, popupId));

    expect((await admin.deleteVariant(db, OWNER_A, variantId)).ok).toBe(true);
    expect((await admin.getVariant(db, OWNER_A, variantId)).ok).toBe(false);
  });

  it("⚠ 稼働中でない(draft/paused)ポップでは、同じ4操作がどれも断られない", async () => {
    const site = await newActiveSite();
    const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "draft" })).id; // 稼働にしない
    const variantId = value(await admin.createVariant(db, OWNER_A, popupId, textInput("唯一"))).id;

    expect((await admin.archiveVariant(db, OWNER_A, variantId)).ok).toBe(true);
    expect((await admin.restoreVariant(db, OWNER_A, variantId)).ok).toBe(true);
    expect((await admin.updateVariant(db, OWNER_A, variantId, imageInput())).ok).toBe(true);
    expect((await admin.deleteVariant(db, OWNER_A, variantId)).ok).toBe(true);
  });

  /*
    🔴 **並行性(Codex #8 2巡目 Should fix)**。ガードは「書き込みと同じ文の WHERE」に埋め込んであるので、
    D1 が1つずつ処理する限り、同じポップの配信可能な2行に対して2つの破壊的操作を**同時に**投げても、
    最初にコミットされた側だけが「他に配信できる行がある」を見て通り、後からコミットされた側は
    「もう無い」を見て断られる、という順序性が保たれるはず——それを実際に `Promise.all` で確かめる。
  */
  describe("並行に撃っても、配信可能な行が0件になる組み合わせは片方しか通らない", () => {
    it("アーカイブ + 削除を同時に", async () => {
      const site = await newActiveSite();
      const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
      const variantA = value(await admin.createVariant(db, OWNER_A, popupId, textInput("A"))).id;
      const variantB = value(await admin.createVariant(db, OWNER_A, popupId, textInput("B"))).id;
      value(await admin.activatePopup(db, OWNER_A, popupId));

      const [archived, deleted] = await Promise.all([
        admin.archiveVariant(db, OWNER_A, variantA),
        admin.deleteVariant(db, OWNER_A, variantB),
      ]);
      const results = [archived, deleted];
      const succeeded = results.filter((r) => r.ok);
      const blocked = results.filter((r) => !r.ok);
      expect(succeeded, "成功は片方だけのはず").toHaveLength(1);
      expect(blocked, "もう片方は断られるはず").toHaveLength(1);
      expect(blocked[0]).toEqual(BLOCKED);

      // 最後に1件だけ配信できる行が残っている(アーカイブされていない/削除されていない、どちらかの行)
      const remaining = await db
        .prepare(
          `select count(*) as c from variants where popup_id = ?1 and archived_at is null and (kind = 'text' or (kind = 'image' and json_extract(content, '$.imageKey') is not null))`,
        )
        .bind(popupId)
        .first<{ c: number }>();
      expect(remaining?.c).toBe(1);
    });

    it("画像を外す + 画像の無い型への変更を同時に", async () => {
      const site = await newActiveSite();
      const popupId = value(await admin.createPopup(db, OWNER_A, site, { name: "p" })).id;
      const imageVariant = value(await admin.createVariant(db, OWNER_A, popupId, imageInput())).id;
      value(await admin.setVariantImage(db, OWNER_A, imageVariant, IMAGE_KEY("0")));
      const textVariant = value(await admin.createVariant(db, OWNER_A, popupId, textInput("B"))).id;
      value(await admin.activatePopup(db, OWNER_A, popupId));

      const [imageRemoved, kindChanged] = await Promise.all([
        admin.setVariantImage(db, OWNER_A, imageVariant, null),
        admin.updateVariant(db, OWNER_A, textVariant, imageInput()), // text → 画像の無い image 型
      ]);
      const results = [imageRemoved, kindChanged];
      const succeeded = results.filter((r) => r.ok);
      const blocked = results.filter((r) => !r.ok);
      expect(succeeded, "成功は片方だけのはず").toHaveLength(1);
      expect(blocked, "もう片方は断られるはず").toHaveLength(1);
      expect(blocked[0]).toEqual(BLOCKED);

      const remaining = await db
        .prepare(
          `select count(*) as c from variants where popup_id = ?1 and archived_at is null and (kind = 'text' or (kind = 'image' and json_extract(content, '$.imageKey') is not null))`,
        )
        .bind(popupId)
        .first<{ c: number }>();
      expect(remaining?.c).toBe(1);
    });
  });
});
