// @vitest-environment node
//
// 管理画面の数値(表示・クリック・閉じた)= `admin.getPopupStats`(PR5a・本部発注 D-330)。
// 固定するもの:
//   ・数える単位は**ポップごと**・クリックは**生の件数**(ユニークに畳まない)
//   ・「直近7日」はリクエスト時刻からの 7×24 時間のローリング窓。7日より前は数えない
//   ・「累計」は期間の制約なし
//   ・**件数0件**と**取得そのものの失敗**を区別する(P-011。0件はグループ化した行が無いだけの正しい値)
//   ・所有者の分離は tests/d1-owner-isolation.test.ts が CASES 経由で撃つ(ここでは重複させない)
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

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

/** events へ直接差し込む(delivery.ts を経由せず、数え方だけを測るための最短路)。 */
async function insertEvent(args: {
  ownerId: string;
  siteId: string;
  popupId: string;
  variantId: string | null;
  kind: "impression" | "click" | "close" | "fire" | "suppressed" | "conversion";
  occurredAt: string;
  impressionId?: string;
}): Promise<void> {
  const impressionId =
    args.impressionId ?? (["impression", "click", "close"].includes(args.kind) ? crypto.randomUUID() : null);
  await db
    .prepare(
      `insert into events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device, close_reason, occurred_at)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'desktop', ?8, ?9)`,
    )
    .bind(
      args.ownerId,
      args.siteId,
      args.popupId,
      args.variantId,
      args.kind,
      args.kind === "impression" ? "exit_intent" : null,
      impressionId,
      args.kind === "close" ? "button" : null,
      args.occurredAt,
    )
    .run();
}

describe("admin.getPopupStats", () => {
  const ids = { site: "", popupA: "", popupB: "", variant: "" };

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;
    value(await admin.ensureOwner(db, OWNER_A));
    ids.site = value(await admin.createSite(db, OWNER_A, { name: "計測", allowedOrigins: [] })).id;
    ids.popupA = value(await admin.createPopup(db, OWNER_A, ids.site, { name: "A" })).id;
    ids.popupB = value(await admin.createPopup(db, OWNER_A, ids.site, { name: "B(イベント無し)" })).id;
    ids.variant = value(
      await admin.createVariant(db, OWNER_A, ids.popupA, {
        kind: "text",
        content: { headline: "x", body: "", buttonLabel: "", imageAlt: "" },
        destinationUrl: "https://offer.example.com/",
      }),
    ).id;

    // popupA: 7日以内の impression 2件・7日より前の impression 1件(累計には入るが直近7日には入らない)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "impression", occurredAt: isoAgo(DAY_MS) });
    const freshImpression = crypto.randomUUID();
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "impression", occurredAt: isoAgo(2 * DAY_MS), impressionId: freshImpression });
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "impression", occurredAt: isoAgo(8 * DAY_MS) });

    // 同じ表示(freshImpression)への click を2回(生の件数で数える・畳まない)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "click", occurredAt: isoAgo(2 * DAY_MS), impressionId: freshImpression });
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "click", occurredAt: isoAgo(2 * DAY_MS), impressionId: freshImpression });

    // close は7日より前に1件だけ(直近7日には出ない・累計には出る)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "close", occurredAt: isoAgo(10 * DAY_MS) });

    // popupA の fire / suppressed は数えない(表示・クリック・閉じたの3種類だけを見る)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: null, kind: "fire", occurredAt: isoAgo(DAY_MS) });
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("🔴 直近7日は 7×24 時間のローリング窓(8日前・10日前は入らない)", async () => {
    const result = value(await admin.getPopupStats(db, OWNER_A, ids.site));
    expect(result[ids.popupA].sevenDay).toEqual({ impression: 2, click: 2, close: 0 });
  });

  it("🔴 累計は期間の制約なし(8日前・10日前も入る)", async () => {
    const result = value(await admin.getPopupStats(db, OWNER_A, ids.site));
    expect(result[ids.popupA].lifetime).toEqual({ impression: 3, click: 2, close: 1 });
  });

  it("🔴 クリックは生の件数(同じ impression_id に2回押されたら2と数える。ユニークに畳まない)", async () => {
    const result = value(await admin.getPopupStats(db, OWNER_A, ids.site));
    expect(result[ids.popupA].sevenDay.click).toBe(2);
  });

  it("✅ イベントが1件も無いポップは 0(件数ゼロ)であって、キー自体が消えたりしない", async () => {
    const result = value(await admin.getPopupStats(db, OWNER_A, ids.site));
    expect(result[ids.popupB]).toEqual({
      sevenDay: { impression: 0, click: 0, close: 0 },
      lifetime: { impression: 0, click: 0, close: 0 },
    });
  });

  it("⚠ fire / suppressed は数えない(表示・クリック・閉じたの3種類だけ)", async () => {
    const result = value(await admin.getPopupStats(db, OWNER_A, ids.site));
    // fire が impression として混ざっていれば 3 になってしまう(直近7日は fire 1件 + impression 2件)
    expect(result[ids.popupA].sevenDay.impression).toBe(2);
  });

  it("🔴 サイトが無い/他人のサイトは not_found(0 件の一覧ではない)", async () => {
    expect(await admin.getPopupStats(db, OWNER_A, crypto.randomUUID())).toEqual({
      ok: false,
      failure: { kind: "not_found" },
    });
  });

  it("🔴 取得そのものが失敗したときは 0 を返さず例外を投げる(P-011。呼び出し側の app.ts が 500 にする)", async () => {
    // DB バインドが無い = 取れない状態。0 件の結果にすり替えず、例外のまま呼び出し側へ届く
    await expect(admin.getPopupStats({}, OWNER_A, ids.site)).rejects.toThrow();
  });
});
