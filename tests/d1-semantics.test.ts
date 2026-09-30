// @vitest-environment node
//
// 🔴 **D1 の性質を、実物(wrangler が起動する workerd の中の D1)で測る。**
//   この PR の守りのいくつかは「D1 がそう振る舞う」ことに乗っている。**推測で書かず、ここで固定する**:
//     ① 外部キーが効く(`pragma foreign_keys = 1`)
//     ② 行トリガは**同じ文で先に入れた行も数える** → 1文で上限を超える複数行は、全部が巻き戻る
//     ③ `batch` は1つのトランザクション(途中で落ちたら前の文も巻き戻る)
//     ④ 失敗の文言に、こちらが RAISE で付けた接頭辞と SQLite の拡張コード名が載る(分類がそれに乗っている)
//   ⚠ D1 の実装が変わってここが落ちたら、**守りの前提が崩れた**ということ。検査を直す前に守りを見直す。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { classifyD1Error } from "../src/lib/data/errors";
import { errorOf, openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;

const uuid = () => crypto.randomUUID();
const hex32 = () => crypto.randomUUID().replaceAll("-", "");

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  await db.prepare("insert into owners (id) values (?1)").bind(OWNER_A).run();
});
afterAll(async () => {
  await t?.dispose();
});

describe("D1 の性質(実測)", () => {
  it("🔴 ① 外部キーが効いている(存在しない所有者のサイトは入らない)", async () => {
    const pragma = await db.prepare("pragma foreign_keys").first<{ foreign_keys: number }>();
    expect(pragma?.foreign_keys).toBe(1);
    const message = await errorOf(() =>
      db
        .prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'x', ?3)")
        .bind(uuid(), uuid(), hex32())
        .run(),
    );
    expect(message).toContain("SQLITE_CONSTRAINT_FOREIGNKEY");
  });

  it("🔴🔴 ② 1文で 21 行入れると、行トリガの上限(20)で全部が巻き戻る", async () => {
    const values = Array.from({ length: 21 }, () => `('${uuid()}', '${OWNER_A}', 's', '${hex32()}')`).join(",");
    const message = await errorOf(() =>
      db.prepare(`insert into sites (id, owner_id, name, site_key) values ${values}`).run(),
    );
    expect(message).toContain("adpop:limit:sites");
    const count = await db.prepare("select count(*) as c from sites").first<{ c: number }>();
    expect(count?.c, "上限を超えた文の行が残った").toBe(0);
  });

  it("✅ ② 1文で 20 行ちょうどは入る(締めすぎていない)", async () => {
    const values = Array.from({ length: 20 }, () => `('${uuid()}', '${OWNER_A}', 's', '${hex32()}')`).join(",");
    await db.prepare(`insert into sites (id, owner_id, name, site_key) values ${values}`).run();
    const count = await db.prepare("select count(*) as c from sites").first<{ c: number }>();
    expect(count?.c).toBe(20);
    await db.prepare("delete from sites").run();
  });

  it("🔴 ③ batch の途中で落ちると、前の文も巻き戻る(1つのトランザクション)", async () => {
    const id = uuid();
    const message = await errorOf(() =>
      db.batch([
        db.prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'batch', ?3)").bind(id, OWNER_A, hex32()),
        db.prepare("insert into site_allowed_origins (site_id, owner_id, origin) values (?1, ?2, 'javascript:x')").bind(id, OWNER_A),
      ]),
    );
    expect(message).toContain("SQLITE_CONSTRAINT");
    const row = await db.prepare("select 1 as x from sites where id = ?1").bind(id).first();
    expect(row, "batch の前半が残った").toBeNull();
  });

  it("🔴 ④ 失敗の文言から、上限・変えてはいけない列・一意・外部キー・CHECK を分類できる", async () => {
    const siteId = uuid();
    await db.prepare("insert into sites (id, owner_id, name, site_key) values (?1, ?2, 'k', ?3)").bind(siteId, OWNER_A, hex32()).run();

    const immutable = await errorOf(() =>
      db.prepare("update sites set site_key = ?1 where id = ?2").bind(hex32(), siteId).run(),
    );
    expect(classifyD1Error(new Error(immutable))).toEqual({ kind: "immutable" });

    const check = await errorOf(() => db.prepare("update sites set name = '  ' where id = ?1").bind(siteId).run());
    expect(classifyD1Error(new Error(check))).toEqual({ kind: "check" });

    const fk = await errorOf(() =>
      db.prepare("insert into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, 'p')")
        .bind(uuid(), OWNER_A, uuid(), hex32()).run(),
    );
    expect(classifyD1Error(new Error(fk))).toEqual({ kind: "foreign_key" });

    const popupA = uuid();
    const popupB = uuid();
    await db.prepare("insert into popups (id, owner_id, site_id, public_key, name, status) values (?1, ?2, ?3, ?4, 'a', 'active')")
      .bind(popupA, OWNER_A, siteId, hex32()).run();
    await db.prepare("insert into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, 'b')")
      .bind(popupB, OWNER_A, siteId, hex32()).run();
    const unique = await errorOf(() => db.prepare("update popups set status = 'active' where id = ?1").bind(popupB).run());
    expect(classifyD1Error(new Error(unique))).toEqual({ kind: "unique" });
    await db.prepare("delete from sites").run();
  });
});
