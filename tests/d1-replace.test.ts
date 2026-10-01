// @vitest-environment node
//
// 🔴🔴 **REPLACE 系の構文で、変更禁止・上限・所有者の守りを迂回できないこと**(Codex #4 Blocker 1)。
//   SQLite の `INSERT OR REPLACE` / `REPLACE INTO` / `UPDATE OR REPLACE` は、衝突した既存の行を**消してから**入れる。
//   消す側は BEFORE UPDATE のトリガを通らず、配下は cascade で消える。UPSERT(`ON CONFLICT DO UPDATE`)も撃つ。
//   ⚠ ここは**データ層を通さずに**直接 SQL を当てる(DB を直接触られたときに何が残るか)。
//   ⚠ 最後の it が、**DB にある一意なキーの一覧**と**ここで撃ったキーの一覧**を突き合わせる(足し忘れると落ちる)。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorOf, openTestD1, OWNER_A, OWNER_B, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;
const hex32 = () => crypto.randomUUID().replaceAll("-", "");
const a = {
  site: crypto.randomUUID(),
  siteKey: hex32(),
  popup: crypto.randomUUID(),
  popupKey: hex32(),
  paused: crypto.randomUUID(),
  variant: crypto.randomUUID(),
  variantKey: hex32(),
  node: crypto.randomUUID(),
  impression: crypto.randomUUID(),
  eventId: 0,
};
const siteB = crypto.randomUUID();

/**
 * 🔴 表の一覧は**DB から引く**(手で並べると、表を足した日に REPLACE の検査の外に置かれる = PR3b で実際に足した)。
 *   ⚠ SQLite と D1 が持つ内部の表(`sqlite_*` / `_cf_*` / `d1_migrations`)は除く。
 */
let TABLES: string[] = [];

async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) out[table] = (await db.prepare(`select * from ${table} order by rowid`).all()).results;
  return out;
}

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  TABLES = (
    await db
      .prepare(
        `select name from sqlite_master where type = 'table'
           and name not like 'sqlite_%' and name not like '\_cf\_%' escape '\\' and name <> 'd1_migrations'
         order by name`,
      )
      .all<{ name: string }>()
  ).results.map((r) => r.name);
  await db.batch([
    db.prepare("insert into owners (id) values (?1), (?2)").bind(OWNER_A, OWNER_B),
    db.prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'A', ?3)").bind(a.site, OWNER_A, a.siteKey),
    db.prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'B', ?3)").bind(siteB, OWNER_B, hex32()),
    db.prepare("insert into site_allowed_origins (site_id, owner_id, origin) values (?1, ?2, 'https://lp.example.com')").bind(a.site, OWNER_A),
    db.prepare("insert into popups (id, owner_id, site_id, public_key, name, status) values (?1, ?2, ?3, ?4, 'active', 'active')").bind(a.popup, OWNER_A, a.site, a.popupKey),
    db.prepare("insert into popups (id, owner_id, site_id, public_key, name, status) values (?1, ?2, ?3, ?4, 'paused', 'paused')").bind(a.paused, OWNER_A, a.site, hex32()),
    db.prepare("insert into variants (id, owner_id, popup_id, public_key, destination_url) values (?1, ?2, ?3, ?4, 'https://o.example.com/')").bind(a.variant, OWNER_A, a.popup, a.variantKey),
    db.prepare("insert into chatbot_nodes (id, owner_id, variant_id, prompt) values (?1, ?2, ?3, 'q')").bind(a.node, OWNER_A, a.variant),
    db.prepare(
      "insert into events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device) values (?1, ?2, ?3, ?4, 'impression', 'exit_intent', ?5, 'mobile')",
    ).bind(OWNER_A, a.site, a.popup, a.variant, a.impression),
    db.prepare(
      "insert into admin_sessions (token_hash, owner_id, password_fingerprint, expires_at) values (?1, ?2, ?3, '2999-01-01T00:00:00.000Z')",
    ).bind("a".repeat(64), OWNER_A, "b".repeat(16)),
    db.prepare("insert into admin_login_attempts (key, window_start, attempts) values (?1, '2026-01-01T00:00:00.000Z', 3)").bind("c".repeat(32)),
  ]);
  a.eventId = (await db.prepare("select id from events").first<{ id: number }>())!.id;
});
afterAll(async () => {
  await t?.dispose();
});

/** 撃ったあと、全表が撃つ前と1バイトも変わっていないこと。 */
async function expectUnchanged(sql: string, params: unknown[], expected: string | "") {
  const before = await snapshot();
  const message = await errorOf(() => db.prepare(sql).bind(...params).run());
  if (expected === "") expect(message, sql).toBe("");
  else expect(message, sql).toContain(expected);
  expect(await snapshot(), `${sql} で行が変わった(消えた・入れ替わった)`).toEqual(before);
}

/** 撃ったキー(最後の it が DB の一意なキーと突き合わせる)。 */
const COVERED = new Set<string>();

describe("REPLACE / UPSERT で既存の行を入れ替えられない", () => {
  it.each([
    ["INSERT OR REPLACE", "insert or replace"],
    ["REPLACE INTO", "replace"],
  ])("🔴 %s: 所有者を付け替えたサイト(同じ id)は入らない・配下は消えない", async (_label, verb) => {
    await expectUnchanged(`${verb} into sites (id, owner_id, name, site_key) values (?1, ?2, '乗っ取り', ?3)`, [a.site, OWNER_B, hex32()], "adpop:conflict:sites");
    COVERED.add("sites(id)");
  });

  it("🔴 同じサイトキーの REPLACE で別のサイトを消せない", async () => {
    await expectUnchanged("insert or replace into sites (id, owner_id, name, site_key) values (?1, ?2, 'x', ?3)", [crypto.randomUUID(), OWNER_B, a.siteKey], "adpop:conflict:sites");
    COVERED.add("sites(site_key)");
  });

  it("🔴 UPSERT(ON CONFLICT DO UPDATE)で所有者を付け替えられない", async () => {
    await expectUnchanged(
      "insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'x', ?3) on conflict (id) do update set owner_id = excluded.owner_id",
      [a.site, OWNER_B, hex32()],
      "adpop:conflict:sites",
    );
  });

  it("🔴 許可ドメインの行を REPLACE できない", async () => {
    await expectUnchanged("insert or replace into site_allowed_origins (site_id, owner_id, origin) values (?1, ?2, 'https://lp.example.com')", [a.site, OWNER_A], "adpop:conflict:site_allowed_origins");
    COVERED.add("site_allowed_origins(site_id,origin)");
  });

  it("🔴 ポップを REPLACE で別サイトへ付け替えられない(同じ id)・同じ公開用の識別子でも消せない", async () => {
    await expectUnchanged("insert or replace into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, 'x')", [a.popup, OWNER_B, siteB, hex32()], "adpop:conflict:popups");
    COVERED.add("popups(id)");
    await expectUnchanged("insert or replace into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, 'x')", [crypto.randomUUID(), OWNER_A, a.site, a.popupKey], "adpop:conflict:popups");
    COVERED.add("popups(public_key)");
  });

  it("🔴 稼働中の REPLACE で、同じサイトの稼働中を消せない(INSERT と UPDATE の両方)", async () => {
    await expectUnchanged(
      "insert or replace into popups (id, owner_id, site_id, public_key, name, status) values (?1, ?2, ?3, ?4, 'x', 'active')",
      [crypto.randomUUID(), OWNER_A, a.site, hex32()],
      "adpop:conflict:popups",
    );
    await expectUnchanged("update or replace popups set status = 'active' where id = ?1", [a.paused], "adpop:conflict:popups");
    COVERED.add("popups(site_id) where active");
  });

  it("🔴 パターンを REPLACE できない(同じ id / 同じ公開用の識別子)", async () => {
    await expectUnchanged("insert or replace into variants (id, owner_id, popup_id, public_key, destination_url) values (?1, ?2, ?3, ?4, 'https://evil.example.com/')", [a.variant, OWNER_A, a.popup, hex32()], "adpop:conflict:variants");
    COVERED.add("variants(id)");
    await expectUnchanged("insert or replace into variants (id, owner_id, popup_id, public_key, destination_url) values (?1, ?2, ?3, ?4, 'https://evil.example.com/')", [crypto.randomUUID(), OWNER_A, a.popup, a.variantKey], "adpop:conflict:variants");
    COVERED.add("variants(public_key)");
  });

  it("🔴 トリガの行を REPLACE できない", async () => {
    await expectUnchanged("insert or replace into popup_triggers (owner_id, popup_id, kind, enabled) values (?1, ?2, 'exit_intent', 0)", [OWNER_A, a.popup], "adpop:conflict:popup_triggers");
    COVERED.add("popup_triggers(popup_id,kind)");
  });

  it("🔴 チャットボットのノード(v1.1)も REPLACE できない・所有者と親を変えられない", async () => {
    await expectUnchanged("insert or replace into chatbot_nodes (id, owner_id, variant_id, prompt) values (?1, ?2, ?3, 'x')", [a.node, OWNER_A, a.variant], "adpop:conflict:chatbot_nodes");
    COVERED.add("chatbot_nodes(id)");
    for (const [sql, params] of [
      ["update chatbot_nodes set owner_id = ?1 where id = ?2", [OWNER_B, a.node]],
      ["update chatbot_nodes set variant_id = ?1 where id = ?2", [crypto.randomUUID(), a.node]],
      ["update chatbot_nodes set parent_node_id = ?1 where id = ?2", [a.node, a.node]],
    ] as const) {
      await expectUnchanged(sql, [...params], "adpop:immutable:chatbot_nodes");
    }
  });

  it("🔴 所有者の REPLACE は黙って捨てられ、配下は消えない / 所有者の id は書き換えられない", async () => {
    await expectUnchanged("insert or replace into owners (id) values (?1)", [OWNER_A], "");
    COVERED.add("owners(id)");
    await expectUnchanged("update or replace owners set id = ?1 where id = ?2", [OWNER_B, OWNER_A], "adpop:immutable:owners");
  });

  it("🔴 イベントの REPLACE(同じ id / 同じ表示)は黙って捨てられ、元の行が残る", async () => {
    await expectUnchanged(
      "insert or replace into events (id, owner_id, site_id, popup_id, kind, device) values (?1, ?2, ?3, ?4, 'fire', 'desktop')",
      [a.eventId, OWNER_A, a.site, a.popup],
      "",
    );
    COVERED.add("events(id)");
    await expectUnchanged(
      "insert or replace into events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device) values (?1, ?2, ?3, ?4, 'impression', 'exit_intent', ?5, 'desktop')",
      [OWNER_A, a.site, a.popup, a.variant, a.impression],
      "",
    );
    COVERED.add("events(site_id,impression_id,kind) where impression/close");
  });

  it("🔴 ログインの表(PR3b)も REPLACE で入れ替えられない・セッションの所有者は変えられない", async () => {
    await expectUnchanged(
      "insert or replace into admin_sessions (token_hash, owner_id, password_fingerprint, expires_at) values (?1, ?2, ?3, '2999-01-01T00:00:00.000Z')",
      ["a".repeat(64), OWNER_B, "d".repeat(16)],
      "adpop:conflict:admin_sessions",
    );
    COVERED.add("admin_sessions(token_hash)");
    await expectUnchanged("update admin_sessions set owner_id = ?1", [OWNER_B], "adpop:immutable:admin_sessions");
    await expectUnchanged(
      "insert or replace into admin_login_attempts (key, window_start, attempts) values (?1, '2026-01-01T00:00:00.000Z', 0)",
      ["c".repeat(32)],
      "adpop:conflict:admin_login_attempts",
    );
    COVERED.add("admin_login_attempts(key)");
  });

  it("🔴 消し直し待ちの画像のキーを REPLACE しても、黙って捨てられる(所有者は変えられない)", async () => {
    await t.db.prepare("insert into pending_image_deletions (key, owner_id) values (?1, ?2)").bind(`images/${"f".repeat(32)}.png`, OWNER_A).run();
    await expectUnchanged("insert or replace into pending_image_deletions (key, owner_id) values (?1, ?2)", [`images/${"f".repeat(32)}.png`, OWNER_B], "");
    COVERED.add("pending_image_deletions(key)");
    await expectUnchanged("update pending_image_deletions set owner_id = ?1", [OWNER_B], "adpop:immutable:pending_image_deletions");
  });

  it("🔴 撃ったキーが、DB にある一意なキーの一覧と一致する(一意なキーを足したら、ここで落ちる。id を含む複合キーは除く)", async () => {
    // 一意なキー = 主キー + unique 制約・一意索引。複合の (id, owner_id) などは、中に id を含むので id の守りが覆う
    const keys = new Set<string>();
    for (const table of TABLES) {
      const pk = (await db.prepare(`select name from pragma_table_info(?1) where pk > 0 order by pk`).bind(table).all<{ name: string }>()).results;
      if (pk.length > 0) keys.add(`${table}(${pk.map((c) => c.name).join(",")})`);
      const indexes = (await db.prepare(`select name, partial from pragma_index_list(?1) where "unique" = 1`).bind(table).all<{ name: string; partial: number }>()).results;
      for (const index of indexes) {
        const cols = (await db.prepare(`select name from pragma_index_info(?1) order by seqno`).bind(index.name).all<{ name: string }>()).results.map((c) => c.name);
        if (cols.includes("id") && cols.length > 1) continue; // (id, owner_id) などは id の守りが覆う
        const key = `${table}(${cols.join(",")})`;
        if (index.partial === 1) {
          keys.add(table === "popups" ? `${key} where active` : `${key} where impression/close`);
        } else keys.add(key);
      }
    }
    expect([...keys].sort()).toEqual([...COVERED].sort());
  });
});
