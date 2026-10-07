// @vitest-environment node
//
// 🔴 索引 `events_site_kind_occurred_at`(db/migrations/0003_event_stats_index.sql・PR5a)の検査
//   (レビュー指摘)。
//
// tests/d1-migration-additive.test.ts は「既存のスキーマが変わらないこと」だけを見るので、
// **この索引自体を消しても**(= 0003 の CREATE INDEX を丸ごと消しても)何も落ちない。
// ここは逆に、**この索引が実在し、列順が (site_id, kind, occurred_at) であること**と、
// **`admin.getPopupStats` が実際に書くクエリが、この索引を使って実行計画を組むこと**を直接固定する。
//
// ⚠ **実測で分かったこと**: 今回 `events` に複数サイト・各200件の行を入れて `ANALYZE` を**実行する前**に
//   `EXPLAIN QUERY PLAN` を撃ったところ、狙った `events_site_kind_occurred_at` ではなく
//   `events_owner_occurred_at` が選ばれた。`ANALYZE` を実行した**後**は、狙いどおりこの索引が選ばれた
//   (この2つの観測事実だけが実測。SQLite の選択アルゴリズムの内部動作そのものは読んでいない=未確認)。
//   → **本番の Cloudflare D1 が `ANALYZE` を自動で走らせるか・走らせる頻度は未確認**。
//   この検査は `ANALYZE` を明示的に呼んでから実行計画を読む(=「統計が十分にある」状態の振る舞いを固定する)。
//   **本番で `ANALYZE` が走っていなければ、この索引は意図どおりに使われない可能性がある**
// ——別途申し送る(PR本文に明記)。
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

const INDEX_NAME = "events_site_kind_occurred_at";

/** `admin.getPopupStats` が書く2つのクエリ(直近7日・累計)と同じ形。実行計画を確かめるためだけに複写する。 */
const SEVEN_DAY_SQL = `select popup_id, kind, count(*) as n from events
   where site_id = ?1 and owner_id = ?2 and occurred_at >= ?3
     and kind in ('impression', 'click', 'close')
   group by popup_id, kind`;
const LIFETIME_SQL = `select popup_id, kind, count(*) as n from events
   where site_id = ?1 and owner_id = ?2
     and kind in ('impression', 'click', 'close')
   group by popup_id, kind`;

let targetSiteId = "";

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;

  /*
    実行計画は「他に選べる索引がどれだけ有利に見えるか」で変わる(実測・上の注記)。
    `events_owner_occurred_at` 等の既存の索引と比べさせるため、**複数サイトに分けて実データ規模で**
    行を入れ、`ANALYZE` を実行してから実行計画を読む。
  */
  const ownerId = OWNER_A;
  value(await admin.ensureOwner(db, ownerId));
  for (let i = 0; i < 5; i += 1) {
    const siteId = value(await admin.createSite(db, ownerId, { name: `site-${i}`, allowedOrigins: [] })).id;
    if (i === 0) targetSiteId = siteId;
    const popupId = value(await admin.createPopup(db, ownerId, siteId, { name: "p" })).id;
    const variantId = value(
      await admin.createVariant(db, ownerId, popupId, {
        kind: "text",
        content: { headline: "x", body: "", buttonLabel: "", imageAlt: "" },
        destinationUrl: "https://offer.example.com/",
      }),
    ).id;
    const insert = db.prepare(
      `insert into events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device)
       values (?1, ?2, ?3, ?4, 'impression', 'exit_intent', ?5, 'desktop')`,
    );
    const batch = Array.from({ length: 200 }, () => insert.bind(ownerId, siteId, popupId, variantId, crypto.randomUUID()));
    // D1 の batch は一度に渡せる本数に上限があるので、50件ずつに分ける
    for (let start = 0; start < batch.length; start += 50) await db.batch(batch.slice(start, start + 50));
  }
  await db.prepare("ANALYZE").run();
});
afterAll(async () => {
  await t?.dispose();
});

describe(`索引 ${INDEX_NAME}(PR5a)`, () => {
  it("🔴 存在し、列の順が (site_id, kind, occurred_at) である(sqlite_master + pragma_index_info)", async () => {
    const row = await db
      .prepare(`select sql from sqlite_master where type = 'index' and name = ?1`)
      .bind(INDEX_NAME)
      .first<{ sql: string }>();
    expect(row, `索引 ${INDEX_NAME} が存在しない`).not.toBeNull();
    expect(row?.sql).toContain("events");

    const columns = (
      await db.prepare(`select name from pragma_index_info(?1) order by seqno`).bind(INDEX_NAME).all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(columns).toEqual(["site_id", "kind", "occurred_at"]);
  });

  it("🔴 ANALYZE 後、admin.getPopupStats が書くクエリ(直近7日・累計)の両方がこの索引を使う(実測の前提つき。上の注記)", async () => {
    for (const [sql, params] of [
      [SEVEN_DAY_SQL, [targetSiteId, OWNER_A, "2000-01-01T00:00:00.000Z"]],
      [LIFETIME_SQL, [targetSiteId, OWNER_A]],
    ] as const) {
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results;
      const detail = plan.map((p) => p.detail).join(" | ");
      expect(detail, `実行計画: ${detail}`).toContain(INDEX_NAME);
    }
  });

  it("✅ admin.getPopupStats は、空のサイトに対しても正しく空を返す(実行計画の検査が実物の関数と食い違っていないこと)", async () => {
    const siteId = value(await admin.createSite(db, OWNER_A, { name: "索引の検査(空)", allowedOrigins: [] })).id;
    const result = value(await admin.getPopupStats(db, OWNER_A, siteId));
    expect(result).toEqual({});
  });
});
