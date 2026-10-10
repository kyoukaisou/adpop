// @vitest-environment node
//
// 管理画面の数値(日別・サイト単位)= `admin.getDailySiteStats`(D-384・ダッシュボードの推移グラフ)。
// 固定するもの:
//   ・単位は**サイト全体**(全ポップ合算・アーカイブ済みを含む。既存の `getPopupStats` と同じ合算範囲)
//   ・「日」は**UTCの暦日**(0時区切り)。`getPopupStats` の「直近7日」=7×24時間のローリング窓とは
//     意図的に違う基準(ダッシュボードの推移グラフは日付の軸を持つため、暦日で切る必要がある)
//   ・期間は 7/30/90 日(今日を含めて period 日ぶん)。数字が無い日も 0 で**必ず**埋める(穴が空かない)
//   ・**件数0件**と**取得そのものの失敗**を区別する(P-011)。失敗(DBバインド無し)は例外のまま投げる
//   ・所有者の分離は tests/d1-owner-isolation.test.ts が CASES 経由で撃つ(ここでは重複させない)
//   ・HTTP層での500/503・period のバリデーションは tests/admin-api.test.ts が撃つ(レビュー指摘と同じ分担)
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as admin from "../src/lib/data/admin";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

async function insertEvent(args: {
  ownerId: string;
  siteId: string;
  popupId: string;
  variantId: string | null;
  kind: "impression" | "click" | "close" | "fire" | "suppressed" | "conversion";
  occurredAt: string;
}): Promise<void> {
  const impressionId = ["impression", "click", "close"].includes(args.kind) ? crypto.randomUUID() : null;
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

// 🔴 固定した「いま」: UTC 2026-10-10T03:00:00.000Z(「今日」= 2026-10-10)。
//   period=7 の起点(最も古い日)は 2026-10-04。
const NOW = new Date("2026-10-10T03:00:00.000Z").getTime();

async function withFixedNow<T>(run: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

describe("admin.getDailySiteStats", () => {
  const ids = { site: "", popupA: "", popupB: "", variantA: "", variantB: "" };

  beforeAll(async () => {
    t = await openTestD1();
    db = t.db;
    value(await admin.ensureOwner(db, OWNER_A));
    ids.site = value(await admin.createSite(db, OWNER_A, { name: "日別集計", allowedOrigins: [] })).id;
    ids.popupA = value(await admin.createPopup(db, OWNER_A, ids.site, { name: "A" })).id;
    ids.popupB = value(await admin.createPopup(db, OWNER_A, ids.site, { name: "B" })).id;
    const variantInput = {
      kind: "text" as const,
      content: { headline: "x", body: "", buttonLabel: "", imageAlt: "" },
      destinationUrl: "https://offer.example.com/",
    };
    ids.variantA = value(await admin.createVariant(db, OWNER_A, ids.popupA, variantInput)).id;
    ids.variantB = value(await admin.createVariant(db, OWNER_A, ids.popupB, variantInput)).id;

    // 🔴 期間の最初の日(2026-10-04)のUTCの0時ちょうど → 含む
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variantA, kind: "impression", occurredAt: "2026-10-04T00:00:00.000Z" });
    // その1ms前(2026-10-03) → 期間の外。含まない
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variantA, kind: "impression", occurredAt: "2026-10-03T23:59:59.999Z" });
    // 「今日」(2026-10-10)の23:59 → 含む(当日の終わりまで)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variantA, kind: "click", occurredAt: "2026-10-10T23:59:59.000Z" });
    // 同じ日(2026-10-07)に、別のポップのイベントも合算される(単位=サイト全体)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variantA, kind: "close", occurredAt: "2026-10-07T12:00:00.000Z" });
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupB, variantId: ids.variantB, kind: "close", occurredAt: "2026-10-07T13:00:00.000Z" });
    // 数えない種類(fire・suppressed・conversion)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: null, kind: "fire", occurredAt: "2026-10-07T12:00:00.000Z" });
  });
  afterAll(async () => {
    await t?.dispose();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("🔴 period 日ぶん、UTCの暦日が1日ずつ連続して返る(穴も重複もない)", async () => {
    const result = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 7)));
    expect(result.map((p) => p.date)).toEqual([
      "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10",
    ]);
  });

  it("🔴 日の区切りはUTCの0時ちょうど(境界の1msで変わる)", async () => {
    const result = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 7)));
    const byDate = new Map(result.map((p) => [p.date, p]));
    expect(byDate.get("2026-10-04")?.impression).toBe(1); // 0時ちょうど → 含む
    // 2026-10-03 は period の外(2026-10-03 の日自体が配列に無い)ので、その1件は合計に出ない
    expect(result.reduce((n, p) => n + p.impression, 0)).toBe(1);
  });

  it("✅ 「今日」の終わり際(23:59:59)も含む", async () => {
    const result = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 7)));
    expect(result.find((p) => p.date === "2026-10-10")?.click).toBe(1);
  });

  it("🔴 単位はサイト全体(全ポップ合算)。1日に2ポップぶんのイベントがあれば合算される", async () => {
    const result = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 7)));
    expect(result.find((p) => p.date === "2026-10-07")?.close).toBe(2);
  });

  it("⚠ fire / suppressed / conversion は数えない(表示・クリック・閉じたの3種類だけ)", async () => {
    const result = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 7)));
    // fire が close や impression に混ざっていれば数字がずれる
    expect(result.reduce((n, p) => n + p.impression + p.click + p.close, 0)).toBe(1 + 1 + 2);
  });

  it("✅ イベントが1件も無い日は 0 で埋まる(行が消えたりしない)", async () => {
    const result = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 7)));
    expect(result.find((p) => p.date === "2026-10-05")).toEqual({ date: "2026-10-05", impression: 0, click: 0, close: 0 });
  });

  it("🔴 period=30/90 でも配列の長さが一致し、最初の日が period ぶん過去になる", async () => {
    const thirty = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 30)));
    expect(thirty).toHaveLength(30);
    expect(thirty[0].date).toBe("2026-09-11");
    expect(thirty[thirty.length - 1].date).toBe("2026-10-10");

    const ninety = value(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, ids.site, 90)));
    expect(ninety).toHaveLength(90);
    expect(ninety[0].date).toBe("2026-07-13");
  });

  it("🔴 サイトが無い/他人のサイトは not_found(0件埋めの配列ではない)", async () => {
    expect(await withFixedNow(() => admin.getDailySiteStats(db, OWNER_A, crypto.randomUUID(), 7))).toEqual({
      ok: false,
      failure: { kind: "not_found" },
    });
  });

  it("🔴 DBバインドが無いと 0 埋めにすり替えず例外を投げる(P-011)", async () => {
    await expect(admin.getDailySiteStats({}, OWNER_A, ids.site, 7)).rejects.toThrow();
  });
});
