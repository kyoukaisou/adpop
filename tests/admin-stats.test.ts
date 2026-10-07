// @vitest-environment node
//
// 管理画面の数値(表示・クリック・閉じた)= `admin.getPopupStats`(PR5a・設計上の要件)。
// 固定するもの:
//   ・数える単位は**ポップごと**・クリックは**生の件数**(ユニークに畳まない)
//   ・「直近7日」はリクエスト時刻からの 7×24 時間の**ローリング窓**そのもの(UTCの暦日にもJSTの暦日にも
// 寄せない)——レビュー指摘: 境界(締切ちょうど・±1ms)と、暦日区切りに退行したら
//     落ちる具体的な時刻を撃つ
//   ・「累計」は期間の制約なし
//   ・**件数0件**と**取得そのものの失敗**を区別する(P-011。0件はグループ化した行が無いだけの正しい値)。
//     ⚠ ここで撃てるのは「DBバインドが無い」経路(= 例外を投げること)まで。「正常なバインドでクエリ自体が
//     失敗したとき、APIが実際に何を返すか(500/503)」は tests/admin-api.test.ts が HTTP 層で撃つ
//     (レビュー指摘)。
//   ・所有者の分離は tests/d1-owner-isolation.test.ts が CASES 経由で撃つ(ここでは重複させない)
//   ・新しい索引 `events_site_kind_occurred_at` の列順と、実クエリでの利用は tests/d1-stats-index.test.ts
//     (レビュー指摘)
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

/*
  🔴 **固定した「いま」(レビュー指摘)**: UTC 2026-10-04T23:30:00.000Z
    = JST 2026-10-05T08:30:00(+09:00)。**UTCの日付とJSTの日付が違う時刻**を選んだ
    (これを選ばないと、UTC暦日・JST暦日のどちらに退行しても同じ結果になり、検査が何も区別できない)。
  真の締切(7×24時間のローリング窓) = NOW − 7日 = 2026-09-27T23:30:00.000Z。
*/
const NOW = new Date("2026-10-04T23:30:00.000Z").getTime();

const BEFORE_CUTOFF_1MS = "2026-09-27T23:29:59.999Z"; // 締切の1ms前 → 含まない
const AT_CUTOFF = "2026-09-27T23:30:00.000Z"; // 締切ちょうど(>= なので含む)
const AFTER_CUTOFF_1MS = "2026-09-27T23:30:00.001Z"; // 締切の1ms後 → 含む
/*
  🔴 締切(23:30)より前だが、**UTCのその日の始まり(00:00)より後**の時刻。
    もし実装が「UTCの暦日」で切っていたら(= その日の00:00以降を全部含めていたら)、
    この時刻は誤って「直近7日」に含まれてしまう。
*/
const UTC_CALENDAR_DAY_TRAP = "2026-09-27T12:00:00.000Z";
/*
  🔴 締切(23:30)より前だが、**JSTのその日の始まり(JST 2026-09-28T00:00 = UTC 2026-09-27T15:00)より後**の時刻。
    もし実装が「JSTの暦日」で切っていたら、この時刻は誤って「直近7日」に含まれてしまう。
*/
const JST_CALENDAR_DAY_TRAP = "2026-09-27T20:00:00.000Z";
const OLDER_THAN_WINDOW = "2026-09-26T23:30:00.000Z"; // NOW の8日前。累計にだけ現れる
const WITHIN_WINDOW = "2026-10-01T00:00:00.000Z"; // 直近7日の内側(click・fire の時刻に使う)
const WAY_OLDER = "2026-09-10T00:00:00.000Z"; // close に使う(直近7日の外・累計には入る)

/** `admin.getPopupStats` が読む `Date.now()` をこの検査の間だけ固定する。 */
async function withFixedNow<T>(run: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

describe("admin.getPopupStats", () => {
  const ids = { site: "", popupA: "", popupB: "", variant: "" };
  let freshImpressionId = "";

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

    const impression = (occurredAt: string, impressionId?: string) =>
      insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "impression", occurredAt, impressionId });
    const click = (occurredAt: string, impressionId: string) =>
      insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "click", occurredAt, impressionId });
    const close = (occurredAt: string, impressionId?: string) =>
      insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: ids.variant, kind: "close", occurredAt, impressionId });

    // 境界(5件)。sevenDay.impression は AT_CUTOFF と AFTER_CUTOFF_1MS の2件だけが入るはず
    await impression(BEFORE_CUTOFF_1MS);
    await impression(AT_CUTOFF);
    freshImpressionId = crypto.randomUUID();
    await impression(AFTER_CUTOFF_1MS, freshImpressionId);
    await impression(UTC_CALENDAR_DAY_TRAP);
    await impression(JST_CALENDAR_DAY_TRAP);
    // 累計にだけ現れる(直近7日より前)
    await impression(OLDER_THAN_WINDOW);

    // 同じ表示(freshImpressionId)への click を2回(生の件数で数える・畳まない)
    await click(WITHIN_WINDOW, freshImpressionId);
    await click(WITHIN_WINDOW, freshImpressionId);

    // close は直近7日より前に1件だけ(直近7日には出ない・累計には出る)
    await close(WAY_OLDER);

    // fire は数えない(直近7日の内側に置いても impression の数に混ざらないことを確かめるため)
    await insertEvent({ ownerId: OWNER_A, siteId: ids.site, popupId: ids.popupA, variantId: null, kind: "fire", occurredAt: WITHIN_WINDOW });
  });
  afterAll(async () => {
    await t?.dispose();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("🔴 直近7日は 7×24 時間のローリング窓そのもの(締切ちょうど=含む・1ms前=含まない・UTC/JSTの暦日区切りに退行したら落ちる)", async () => {
    const result = value(await withFixedNow(() => admin.getPopupStats(db, OWNER_A, ids.site)));
    // impression: BEFORE_CUTOFF_1MS(含まない)・UTC_CALENDAR_DAY_TRAP(含まない)・JST_CALENDAR_DAY_TRAP(含まない)・
    //   OLDER_THAN_WINDOW(含まない)を除き、AT_CUTOFF・AFTER_CUTOFF_1MS の2件だけ
    expect(result[ids.popupA].sevenDay).toEqual({ impression: 2, click: 2, close: 0 });
  });

  it("🔴 累計は期間の制約なし(境界より前・8日前・10日前もすべて入る)", async () => {
    const result = value(await withFixedNow(() => admin.getPopupStats(db, OWNER_A, ids.site)));
    // impression 6件(境界5件 + OLDER_THAN_WINDOW)・click 2件・close 1件
    expect(result[ids.popupA].lifetime).toEqual({ impression: 6, click: 2, close: 1 });
  });

  it("🔴 クリックは生の件数(同じ impression_id に2回押されたら2と数える。ユニークに畳まない)", async () => {
    const result = value(await withFixedNow(() => admin.getPopupStats(db, OWNER_A, ids.site)));
    expect(result[ids.popupA].sevenDay.click).toBe(2);
  });

  it("⚠ fire / suppressed は数えない(表示・クリック・閉じたの3種類だけ)", async () => {
    const result = value(await withFixedNow(() => admin.getPopupStats(db, OWNER_A, ids.site)));
    // fire が impression として混ざっていれば 3 になってしまう(直近7日は fire 1件 + impression 2件)
    expect(result[ids.popupA].sevenDay.impression).toBe(2);
  });

  it("✅ イベントが1件も無いポップは 0(件数ゼロ)であって、キー自体が消えたりしない", async () => {
    const result = value(await withFixedNow(() => admin.getPopupStats(db, OWNER_A, ids.site)));
    expect(result[ids.popupB]).toEqual({
      sevenDay: { impression: 0, click: 0, close: 0 },
      lifetime: { impression: 0, click: 0, close: 0 },
    });
  });

  it("🔴 サイトが無い/他人のサイトは not_found(0 件の一覧ではない)", async () => {
    expect(await withFixedNow(() => admin.getPopupStats(db, OWNER_A, crypto.randomUUID()))).toEqual({
      ok: false,
      failure: { kind: "not_found" },
    });
  });

  it("🔴 DBバインドが無いと 0 にすり替えず例外を投げる(P-011)", async () => {
    /*
      ⚠ ここで撃っているのは「バインドが無い」経路(`resolveDb` が `MissingBindingError` を投げる)だけ。
        管理画面の Worker(`src/admin/app.ts`)では、この経路は `onError` の `MissingBindingError` 分岐で
        **503**("config")になる(=設定の問題)。**正常なバインドの状態でクエリ自体が失敗したとき**に
        初めて `onError` の既定分岐(**500**・"upstream")に落ちる——その経路は HTTP 層でしか再現できない
        ので tests/admin-api.test.ts が撃つ(レビュー指摘)。ここで確かめたいのは
        「0 件という"正常な結果"にすり替えず、必ず例外のまま呼び出し側へ届く」ことだけ。
    */
    await expect(admin.getPopupStats({}, OWNER_A, ids.site)).rejects.toThrow();
  });
});
