// @vitest-environment node
//
// D1 のスキーマ(db/migrations/0001_schema.sql)が **DB の側で**断るものを、実物のローカル D1 で測る。
// 🔴 ここは**データ層を通さずに**直接 SQL を当てる —— 「DB を直接触られた」(wrangler d1 execute 等)ときに
//   何が残って何が弱くなったかを、測った範囲で書くため。
// ⚠ 形の完全な判定はアプリ(src/lib/data/shapes.ts)。DB に残せたのは GLOB / LIKE で書ける範囲だけで、
//   **DB だけでは通ってしまう形**も「【限界】」として固定してある(強くなったらその it を直す)。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorOf, openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;
const hex32 = () => crypto.randomUUID().replaceAll("-", "");

const ids = { site: crypto.randomUUID(), site2: crypto.randomUUID(), popup: crypto.randomUUID(), popup2: crypto.randomUUID(), variant: crypto.randomUUID(), variantOther: crypto.randomUUID() };

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  await db.prepare("insert into owners (id) values (?1)").bind(OWNER_A).run();
  await db.batch([
    db.prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, 's1', ?3)").bind(ids.site, OWNER_A, hex32()),
    db.prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, 's2', ?3)").bind(ids.site2, OWNER_A, hex32()),
    db.prepare("insert into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, 'p1')").bind(ids.popup, OWNER_A, ids.site, hex32()),
    db.prepare("insert into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, 'p2')").bind(ids.popup2, OWNER_A, ids.site2, hex32()),
    db.prepare("insert into variants (id, owner_id, popup_id, public_key, destination_url) values (?1, ?2, ?3, ?4, 'https://offer.example.com/')").bind(ids.variant, OWNER_A, ids.popup, hex32()),
    db.prepare("insert into variants (id, owner_id, popup_id, public_key, destination_url) values (?1, ?2, ?3, ?4, 'https://offer.example.com/')").bind(ids.variantOther, OWNER_A, ids.popup2, hex32()),
  ]);
});
afterAll(async () => {
  await t?.dispose();
});

const setDestination = (url: string) =>
  errorOf(() => db.prepare("update variants set destination_url = ?1 where id = ?2").bind(url, ids.variant).run());
const addOrigin = async (origin: string) => {
  const message = await errorOf(() =>
    db.prepare("insert into site_allowed_origins (site_id, owner_id, origin) values (?1, ?2, ?3)").bind(ids.site, OWNER_A, origin).run(),
  );
  await db.prepare("delete from site_allowed_origins where site_id = ?1").bind(ids.site).run();
  return message;
};
const event = (fields: Record<string, unknown>) => {
  const row = { owner_id: OWNER_A, site_id: ids.site, popup_id: ids.popup, variant_id: null, kind: "fire", trigger_kind: null, impression_id: null, close_reason: null, device: "mobile", page_url: null, ...fields };
  const keys = Object.keys(row);
  return errorOf(() =>
    db
      .prepare(`insert into events (${keys.join(", ")}) values (${keys.map((_, i) => `?${i + 1}`).join(", ")})`)
      .bind(...Object.values(row))
      .run(),
  );
};

describe("遷移先 URL(DB の側)", () => {
  it.each(["javascript:alert(1)", "data:text/html,x", "http://offer.example.com/", "https://offer.example.com/a b", 'https://offer.example.com/"x', "https://offer.example.com/<x>", "https://"])(
    "🔴 %s は保存できない",
    async (url) => {
      expect(await setDestination(url)).toContain("SQLITE_CONSTRAINT_CHECK");
    },
  );
  it("✅ https の普通のリンクは保存できる", async () => {
    expect(await setDestination("https://px.a8.net/svt/ejp?a8mat=1&x=%E3%81%82")).toBe("");
  });
});

describe("許可ドメイン(DB の側)", () => {
  it.each(["http://lp.example.com", "https://lp.example.com/path", "https://LP.example.com", "https://lp.example.com?x", "https://.example.com", "javascript:x"])(
    "🔴 %s は保存できない",
    async (origin) => {
      expect(await addOrigin(origin)).toContain("SQLITE_CONSTRAINT_CHECK");
    },
  );
  it("✅ https://lp.example.com と https://lp.example.com:8443 は保存できる", async () => {
    expect(await addOrigin("https://lp.example.com")).toBe("");
    expect(await addOrigin("https://lp.example.com:8443")).toBe("");
  });
  it("⚠【限界】`https://localhost` のようなドットの無いホストは DB だけでは通る(判定はアプリの isOrigin)", async () => {
    expect(await addOrigin("https://localhost")).toBe("");
  });
});

describe("計測イベントの形(要件書 §4-7・§6 裁定4)", () => {
  it.each([
    ["query 付きの page_url", { page_url: "https://lp.example.com/a?email=x" }],
    ["fragment 付きの page_url", { page_url: "https://lp.example.com/a#x" }],
    ["ホストに @ を含む page_url(メールを入れる形)", { page_url: "https://taro@example.com/a" }],
    ["空白を含む page_url", { page_url: "https://lp.example.com/a b" }],
    ["端末が2値でない", { device: "tablet" }],
    ["表示なのにトリガ種別が無い", { kind: "impression", variant_id: ids.variant, impression_id: crypto.randomUUID() }],
    ["閉じるなのに理由が無い", { kind: "close", variant_id: ids.variant, impression_id: crypto.randomUUID() }],
    ["発火に表示 ID が付いている", { impression_id: crypto.randomUUID() }],
    ["匿名IDが16進32桁でない", { visitor_hash: "taro@example.com" }],
    ["クリックに表示 ID が無い", { kind: "click", variant_id: ids.variant }],
  ])("🔴 %s は入らない", async (_label, fields) => {
    expect(await event(fields)).toContain("SQLITE_CONSTRAINT");
  });

  it("✅ origin だけ・origin + path・path の @ は入る(締めすぎていない)", async () => {
    for (const url of ["https://lp.example.com", "https://lp.example.com/a/b", "https://lp.example.com/@handle"]) {
      expect(await event({ page_url: url }), url).toBe("");
    }
  });

  it("🔴 階層の一致: 別サイトのポップ・別ポップのパターンを指すイベントは入らない(外部キー)", async () => {
    expect(await event({ popup_id: ids.popup2 })).toContain("SQLITE_CONSTRAINT_FOREIGNKEY");
    expect(
      await event({ kind: "impression", trigger_kind: "exit_intent", impression_id: crypto.randomUUID(), variant_id: ids.variantOther }),
    ).toContain("SQLITE_CONSTRAINT_FOREIGNKEY");
    expect(await event({ popup_id: null, kind: "conversion", variant_id: ids.variant })).toContain("SQLITE_CONSTRAINT");
  });

  it("🔴 表示は同じサイト × 表示 ID で1回だけ(一意索引)", async () => {
    const impression = { kind: "impression", trigger_kind: "exit_intent", variant_id: ids.variant, impression_id: crypto.randomUUID() };
    expect(await event(impression)).toBe("");
    // ⚠ 2回目は断りではなく**黙って捨てる**(BEFORE INSERT の RAISE(IGNORE)。データ層の ON CONFLICT DO NOTHING と同じ意味)
    expect(await event(impression)).toBe("");
    const c = await db.prepare("select count(*) as c from events where impression_id = ?1").bind(impression.impression_id).first<{ c: number }>();
    expect(c?.c).toBe(1);
  });

  it("🔴 書いたイベントは書き換えられない", async () => {
    expect(await errorOf(() => db.prepare("update events set device = 'desktop'").run())).toContain("adpop:immutable:events");
  });
});

describe("ポップ・トリガ", () => {
  it("🔴 ポップを作ると、6トリガの行が既定値(要件書 §4-2)で揃う", async () => {
    const rows = await db
      .prepare("select kind, enabled, threshold from popup_triggers where popup_id = ?1 order by kind")
      .bind(ids.popup)
      .all();
    expect(rows.results).toEqual([
      { kind: "back", enabled: 1, threshold: null },
      { kind: "dwell", enabled: 0, threshold: 45 },
      { kind: "exit_intent", enabled: 1, threshold: null },
      { kind: "idle", enabled: 0, threshold: 30 },
      { kind: "scroll", enabled: 0, threshold: 50 },
      { kind: "visibility", enabled: 0, threshold: null },
    ]);
  });

  it("🔴 同じ種類のトリガの行は2つ作れない(主キー) / トリガの種類・親は書き換えられない", async () => {
    expect(
      await errorOf(() =>
        db.prepare("insert into popup_triggers (owner_id, popup_id, kind) values (?1, ?2, 'scroll')").bind(OWNER_A, ids.popup).run(),
      ),
    ).toContain("adpop:conflict:popup_triggers");
    expect(
      await errorOf(() => db.prepare("update popup_triggers set kind = 'scroll' where popup_id = ?1 and kind = 'back'").bind(ids.popup).run()),
    ).toContain("adpop:immutable:popup_triggers");
    expect(
      await errorOf(() => db.prepare("update popup_triggers set popup_id = ?1 where popup_id = ?2").bind(ids.popup2, ids.popup).run()),
    ).toContain("adpop:immutable:popup_triggers");
  });

  it("🔴 親の付け替え・公開用の識別子・所有者は書き換えられない", async () => {
    for (const [sql, params] of [
      ["update popups set site_id = ?1 where id = ?2", [ids.site2, ids.popup]],
      ["update popups set public_key = ?1 where id = ?2", [hex32(), ids.popup]],
      ["update variants set popup_id = ?1 where id = ?2", [ids.popup2, ids.variant]],
      ["update variants set public_key = ?1 where id = ?2", [hex32(), ids.variant]],
      ["update sites set site_key = ?1 where id = ?2", [hex32(), ids.site]],
      ["update sites set owner_id = ?1 where id = ?2", [OWNER_A.replace("a", "c"), ids.site]],
    ] as const) {
      expect(await errorOf(() => db.prepare(sql).bind(...params).run()), sql).toContain("adpop:immutable:");
    }
  });

  it("🔴 1サイトに稼働中は1つ / アーカイブしたポップは稼働にできない", async () => {
    const other = crypto.randomUUID();
    await db.prepare("insert into popups (id, owner_id, site_id, public_key, name, status) values (?1, ?2, ?3, ?4, 'x', 'active')").bind(other, OWNER_A, ids.site, hex32()).run();
    expect(await errorOf(() => db.prepare("update popups set status = 'active' where id = ?1").bind(ids.popup).run())).toContain(
      "adpop:conflict:popups",
    );
    expect(
      await errorOf(() => db.prepare("update popups set archived_at = '2026-01-01T00:00:00.000Z' where id = ?1").bind(other).run()),
    ).toContain("SQLITE_CONSTRAINT_CHECK");
    await db.prepare("delete from popups where id = ?1").bind(other).run();
  });

  it("⚠ ポップを消すと、配下のトリガ・パターン・数字も消える(cascade。画面は確認してから)", async () => {
    const popupId = crypto.randomUUID();
    const variantId = crypto.randomUUID();
    await db.batch([
      db.prepare("insert into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, 'del')").bind(popupId, OWNER_A, ids.site, hex32()),
      db.prepare("insert into variants (id, owner_id, popup_id, public_key, destination_url) values (?1, ?2, ?3, ?4, 'https://o.example.com/')").bind(variantId, OWNER_A, popupId, hex32()),
    ]);
    expect(await event({ popup_id: popupId })).toBe("");
    await db.prepare("delete from popups where id = ?1").bind(popupId).run();
    for (const table of ["popup_triggers", "variants", "events"]) {
      const c = await db.prepare(`select count(*) as c from ${table} where popup_id = ?1`).bind(popupId).first<{ c: number }>();
      expect(c?.c, table).toBe(0);
    }
  });
});
