// @vitest-environment node
//
// 稼働の切り替え(`activatePopup`)を実物のローカル D1 で測る。
// 🔴 守りたいもの: 1サイトに稼働中は1つ / 配れるパターンが無いポップは稼働にしない /
//   **稼働にできなかったとき、いまの稼働中を止めない**(「止めたが動かせなかった」を作らない)。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;
const p = { first: "", second: "", imageOnly: "", imageWithKey: "", empty: "", archivedOnly: "" };

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}
const input = (kind: admin.VariantKind): admin.VariantInput => ({
  kind,
  // ⚠ imageAlt を入れておく(画像型・ボタン文言なしの組み合わせは必須なので、text 型にも同じ形で揃える)
  content: { headline: "h", body: "", buttonLabel: "", imageAlt: "説明" },
  destinationUrl: "https://offer.example.com/",
});
const statusOf = async (id: string) =>
  (await db.prepare("select status from popups where id = ?1").bind(id).first<{ status: string }>())?.status;

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  value(await admin.ensureOwner(db, OWNER_A));
  const site = value(await admin.createSite(db, OWNER_A, { name: "切り替え", allowedOrigins: [] })).id;
  for (const key of Object.keys(p) as Array<keyof typeof p>) {
    p[key] = value(await admin.createPopup(db, OWNER_A, site, { name: key })).id;
  }
  value(await admin.createVariant(db, OWNER_A, p.first, input("text")));
  value(await admin.createVariant(db, OWNER_A, p.second, input("text")));
  value(await admin.createVariant(db, OWNER_A, p.imageOnly, input("image")));
  const archived = value(await admin.createVariant(db, OWNER_A, p.archivedOnly, input("text"))).id;
  value(await admin.archiveVariant(db, OWNER_A, archived));
  // 🔴 画像が設定された画像型(PR4a で配信対象になった)。`imageOnly` とは違い imageKey が入っている
  const withImage = value(await admin.createVariant(db, OWNER_A, p.imageWithKey, input("image"))).id;
  value(await admin.setVariantImage(db, OWNER_A, withImage, `images/${"c".repeat(32)}.png`));
});
afterAll(async () => {
  await t?.dispose();
});

describe("稼働の切り替え", () => {
  it("✅ 稼働にできる", async () => {
    expect(await admin.activatePopup(db, OWNER_A, p.first)).toEqual({ ok: true, value: null });
    expect(await statusOf(p.first)).toBe("active");
  });

  it("🔴 別のポップを稼働にすると、前の稼働中は停止になる", async () => {
    expect(await admin.activatePopup(db, OWNER_A, p.second)).toEqual({ ok: true, value: null });
    expect(await statusOf(p.second)).toBe("active");
    expect(await statusOf(p.first)).toBe("paused");
  });

  it.each([
    ["パターンが無い", "empty"],
    ["画像型だが画像が未設定(配信の定義と同じ = PR4a でも配らない)", "imageOnly"],
    ["アーカイブ済みのパターンしか無い", "archivedOnly"],
  ] as const)("🔴 %s ポップは稼働にせず、いまの稼働中も止めない", async (_label, key) => {
    expect(await admin.activatePopup(db, OWNER_A, p[key])).toEqual({
      ok: false,
      failure: { kind: "no_deliverable_variant" },
    });
    expect(await statusOf(p[key])).not.toBe("active");
    expect(await statusOf(p.second), "失敗したのに、いまの稼働中が止まった").toBe("active");
  });

  it("🔴 アーカイブしたポップは稼働にできない(見つからない扱い)・いまの稼働中は止めない", async () => {
    value(await admin.archivePopup(db, OWNER_A, p.first));
    expect(await admin.activatePopup(db, OWNER_A, p.first)).toEqual({ ok: false, failure: { kind: "not_found" } });
    expect(await statusOf(p.second)).toBe("active");
    value(await admin.restorePopup(db, OWNER_A, p.first));
  });

  it("🔴 稼働中をアーカイブすると、同じ更新で停止になる(稼働中のままアーカイブ済みにならない)", async () => {
    value(await admin.archivePopup(db, OWNER_A, p.second));
    expect(await statusOf(p.second)).toBe("paused");
  });

  it("✅ 画像が設定された画像型パターンは配信対象になり、稼働にできる(PR4a)", async () => {
    expect(await admin.activatePopup(db, OWNER_A, p.imageWithKey)).toEqual({ ok: true, value: null });
    expect(await statusOf(p.imageWithKey)).toBe("active");
  });
});
