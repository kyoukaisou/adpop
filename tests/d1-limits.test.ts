// @vitest-environment node
//
// 件数の上限(サイト 20 / ポップ 50 / パターン 5・D-296)を、実物のローカル D1 で測る。
// 🔴 **上限を効かせているのは DB のトリガ**。ここはデータ層(src/lib/data/admin.ts)を通して撃ち、
//   ①ちょうどは通る ②1件超えは `limit` で断られる ③1文で超えても1行も残らない
//   ④アーカイブ済みは数えない ⑤アーカイブから戻すときにも数える、を固定する。
// ⚠ 画面に出す値(`LIMITS`)とトリガの値がずれると、①か②が落ちる。
// ⚠ 同時実行は「D1 は1つのデータベースのクエリを1つずつ処理する」(公式)に乗っている。
//   2つの要求を**本当に並べて**撃つ検査は、ローカルでは並びが保証されないので置いていない(PR 本文)。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import { LIMITS } from "../src/lib/data/limits";
import { errorOf, openTestD1, OWNER_A, OWNER_B, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

const variantInput = (n: number): admin.VariantInput => ({
  kind: "text",
  content: { headline: `案${n}`, body: "", buttonLabel: "", imageAlt: "" },
  destinationUrl: `https://offer.example.com/${n}`,
});

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  value(await admin.ensureOwner(db, OWNER_A));
  value(await admin.ensureOwner(db, OWNER_B));
});
afterAll(async () => {
  await t?.dispose();
});

describe(`サイト(1人 ${LIMITS.sites})`, () => {
  it("✅ ちょうどは作れる / 🔴 1件超えは limit で断られる / ✅ 他人の枠には数えない", async () => {
    for (let i = 0; i < LIMITS.sites; i += 1) value(await admin.createSite(db, OWNER_B, { name: `s${i}`, allowedOrigins: [] }));
    const over = await admin.createSite(db, OWNER_B, { name: "超え", allowedOrigins: [] });
    expect(over).toEqual({ ok: false, failure: { kind: "limit", target: "sites" } });
    expect((await admin.createSite(db, OWNER_A, { name: "A の1件", allowedOrigins: [] })).ok).toBe(true);
  });

  it("🔴 1文で上限+1行入れても、1行も残らない", async () => {
    await db.prepare("delete from sites where owner_id = ?1").bind(OWNER_B).run();
    const values = Array.from(
      { length: LIMITS.sites + 1 },
      () => `('${crypto.randomUUID()}', '${OWNER_B}', 'bulk', '${crypto.randomUUID().replaceAll("-", "")}')`,
    ).join(",");
    expect(await errorOf(() => db.prepare(`insert into sites (id, owner_id, name, site_key) values ${values}`).run())).toContain(
      "adpop:limit:sites",
    );
    const c = await db.prepare("select count(*) as c from sites where owner_id = ?1").bind(OWNER_B).first<{ c: number }>();
    expect(c?.c).toBe(0);
  });
});

describe(`ポップ(1サイト ${LIMITS.popupsPerSite}・アーカイブ済みは数えない)`, () => {
  let siteId = "";
  const ids: string[] = [];
  beforeAll(async () => {
    siteId = value(await admin.createSite(db, OWNER_A, { name: "ポップ上限", allowedOrigins: [] })).id;
  });

  it("✅ ちょうどは作れる / 🔴 1件超えは断られる", async () => {
    for (let i = 0; i < LIMITS.popupsPerSite; i += 1) ids.push(value(await admin.createPopup(db, OWNER_A, siteId, { name: `p${i}` })).id);
    expect(await admin.createPopup(db, OWNER_A, siteId, { name: "超え" })).toEqual({
      ok: false,
      failure: { kind: "limit", target: "popupsPerSite" },
    });
  });

  it("✅ 1件アーカイブすると1件作れる / 🔴 戻すと超える側は断られる", async () => {
    value(await admin.archivePopup(db, OWNER_A, ids[0]));
    expect((await admin.createPopup(db, OWNER_A, siteId, { name: "入れ替え" })).ok).toBe(true);
    expect(await admin.restorePopup(db, OWNER_A, ids[0])).toEqual({
      ok: false,
      failure: { kind: "limit", target: "popupsPerSite" },
    });
    const c = await db
      .prepare("select count(*) as c from popups where site_id = ?1 and archived_at is null")
      .bind(siteId)
      .first<{ c: number }>();
    expect(c?.c).toBe(LIMITS.popupsPerSite);
  });

  it("✅ 上限に関係ない更新(名前・頻度)は、上限ちょうどでも通る", async () => {
    expect(await admin.renamePopup(db, OWNER_A, ids[1], "改名")).toEqual({ ok: true, value: null });
    expect(
      await admin.updateFrequency(db, OWNER_A, ids[1], {
        suppressDays: 1,
        sessionImpressions: 2,
        postConversionDays: 3,
        minDisplayDelaySeconds: 4,
      }),
    ).toEqual({ ok: true, value: null });
  });
});

describe(`パターン(1ポップ ${LIMITS.variantsPerPopup}・アーカイブ済みは数えない)`, () => {
  let popupId = "";
  const ids: string[] = [];
  beforeAll(async () => {
    const siteId = value(await admin.createSite(db, OWNER_A, { name: "パターン上限", allowedOrigins: [] })).id;
    popupId = value(await admin.createPopup(db, OWNER_A, siteId, { name: "p" })).id;
  });

  it("🔴 1文で上限+1行入れても、1行も残らない", async () => {
    const values = Array.from(
      { length: LIMITS.variantsPerPopup + 1 },
      (_, i) =>
        `('${crypto.randomUUID()}', '${OWNER_A}', '${popupId}', '${crypto.randomUUID().replaceAll("-", "")}', 'https://offer.example.com/${i}')`,
    ).join(",");
    expect(
      await errorOf(() =>
        db.prepare(`insert into variants (id, owner_id, popup_id, public_key, destination_url) values ${values}`).run(),
      ),
    ).toContain("adpop:limit:variantsPerPopup");
    const c = await db.prepare("select count(*) as c from variants where popup_id = ?1").bind(popupId).first<{ c: number }>();
    expect(c?.c).toBe(0);
  });

  it("✅ ちょうど / 🔴 1件超え / ✅ アーカイブで空く / 🔴 戻すと超える", async () => {
    for (let i = 0; i < LIMITS.variantsPerPopup; i += 1) ids.push(value(await admin.createVariant(db, OWNER_A, popupId, variantInput(i))).id);
    expect(await admin.createVariant(db, OWNER_A, popupId, variantInput(99))).toEqual({
      ok: false,
      failure: { kind: "limit", target: "variantsPerPopup" },
    });
    value(await admin.archiveVariant(db, OWNER_A, ids[0]));
    expect((await admin.createVariant(db, OWNER_A, popupId, variantInput(100))).ok).toBe(true);
    expect(await admin.restoreVariant(db, OWNER_A, ids[0])).toEqual({
      ok: false,
      failure: { kind: "limit", target: "variantsPerPopup" },
    });
  });
});
