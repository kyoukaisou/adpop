// @vitest-environment node
//
// 🔴🔴 **所有者の分離(旧版の RLS の代わり)を、データ層の全関数について撃つ。**
//   D1 には RLS が無いので、分離は `src/lib/data/admin.ts` の関数がそれぞれ持っている。
//   → **公開している関数を実行時に列挙し、1本残らず「他人(B)として A の行を指す」形で呼ぶ。**
//   → **関数を足して、ここに撃ち方を書き忘れると落ちる**(一覧と撃ち方の集合を突き合わせる)。
//   → 全部撃ったあとに、**A の行が1バイトも変わっていない**ことを表ごと比べる。
// ⚠ 測っているのは「データ層の関数を通した経路」だけ。D1 を直接触る経路(wrangler・API トークン)は測れない。
//   データ層の外から D1 に触っていないことは `tests/d1-access-boundary.test.ts` が見る。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import * as images from "../src/lib/data/images";
import { openTestD1, OWNER_A, OWNER_B, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;
const a = { site: "", popup: "", variant: "", archivedPopup: "", archivedVariant: "" };

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

const NOT_FOUND = { ok: false, failure: { kind: "not_found" } };
const FOREIGN_KEY = { ok: false, failure: { kind: "foreign_key" } };
const variantInput: admin.VariantInput = {
  kind: "text",
  content: { headline: "B が書いた", body: "", buttonLabel: "" },
  destinationUrl: "https://evil.example.com/",
};

type Case = (db: D1Database) => Promise<unknown>;
type Expect = (result: unknown) => void | Promise<void>;

/**
 * 🔴 **関数ごとの撃ち方と期待値**。キーの集合は `admin` の公開関数の集合と一致しなければならない。
 */
const CASES: Record<string, [Case, Expect]> = {
  ensureOwner: [(d) => admin.ensureOwner(d, OWNER_B), (r) => expect(r).toEqual({ ok: true, value: null })],
  listSites: [
    (d) => admin.listSites(d, OWNER_B),
    (r) => expect(JSON.stringify(r)).not.toContain(a.site),
  ],
  getSite: [(d) => admin.getSite(d, OWNER_B, a.site), (r) => expect(r).toEqual(NOT_FOUND)],
  createSite: [
    (d) => admin.createSite(d, OWNER_B, { name: "B のサイト", allowedOrigins: [] }),
    async (r) => {
      // 作られるのは B の行だけ(所有者を取り違えない)
      const id = (r as { value: { id: string } }).value.id;
      const row = await db.prepare("select owner_id from sites where id = ?1").bind(id).first<{ owner_id: string }>();
      expect(row?.owner_id).toBe(OWNER_B);
    },
  ],
  updateSite: [
    (d) => admin.updateSite(d, OWNER_B, a.site, { name: "乗っ取り", allowedOrigins: ["https://evil.example.com"] }),
    (r) => expect(r).toEqual(NOT_FOUND),
  ],
  deleteSite: [(d) => admin.deleteSite(d, OWNER_B, a.site), (r) => expect(r).toEqual(NOT_FOUND)],
  listPopups: [(d) => admin.listPopups(d, OWNER_B, a.site), (r) => expect(r).toEqual({ ok: true, value: [] })],
  getPopup: [(d) => admin.getPopup(d, OWNER_B, a.popup), (r) => expect(r).toEqual(NOT_FOUND)],
  createPopup: [(d) => admin.createPopup(d, OWNER_B, a.site, { name: "寄生" }), (r) => expect(r).toEqual(FOREIGN_KEY)],
  renamePopup: [(d) => admin.renamePopup(d, OWNER_B, a.popup, "乗っ取り"), (r) => expect(r).toEqual(NOT_FOUND)],
  updateFrequency: [
    (d) =>
      admin.updateFrequency(d, OWNER_B, a.popup, {
        suppressDays: 0,
        sessionImpressions: 99,
        postConversionDays: 0,
        minDisplayDelaySeconds: 0,
      }),
    (r) => expect(r).toEqual(NOT_FOUND),
  ],
  pausePopup: [(d) => admin.pausePopup(d, OWNER_B, a.popup), (r) => expect(r).toEqual(NOT_FOUND)],
  archivePopup: [(d) => admin.archivePopup(d, OWNER_B, a.popup), (r) => expect(r).toEqual(NOT_FOUND)],
  restorePopup: [(d) => admin.restorePopup(d, OWNER_B, a.archivedPopup), (r) => expect(r).toEqual(NOT_FOUND)],
  deletePopup: [(d) => admin.deletePopup(d, OWNER_B, a.popup), (r) => expect(r).toEqual(NOT_FOUND)],
  activatePopup: [(d) => admin.activatePopup(d, OWNER_B, a.popup), (r) => expect(r).toEqual(NOT_FOUND)],
  listTriggers: [(d) => admin.listTriggers(d, OWNER_B, a.popup), (r) => expect(r).toEqual({ ok: true, value: [] })],
  setTriggerEnabled: [
    (d) => admin.setTriggerEnabled(d, OWNER_B, a.popup, "exit_intent", false),
    (r) => expect(r).toEqual(NOT_FOUND),
  ],
  listVariants: [(d) => admin.listVariants(d, OWNER_B, a.popup), (r) => expect(r).toEqual({ ok: true, value: [] })],
  getVariant: [(d) => admin.getVariant(d, OWNER_B, a.variant), (r) => expect(r).toEqual(NOT_FOUND)],
  createVariant: [(d) => admin.createVariant(d, OWNER_B, a.popup, variantInput), (r) => expect(r).toEqual(FOREIGN_KEY)],
  updateVariant: [(d) => admin.updateVariant(d, OWNER_B, a.variant, variantInput), (r) => expect(r).toEqual(NOT_FOUND)],
  archiveVariant: [(d) => admin.archiveVariant(d, OWNER_B, a.variant), (r) => expect(r).toEqual(NOT_FOUND)],
  restoreVariant: [
    (d) => admin.restoreVariant(d, OWNER_B, a.archivedVariant),
    (r) => expect(r).toEqual(NOT_FOUND),
  ],
  deleteVariant: [(d) => admin.deleteVariant(d, OWNER_B, a.variant), (r) => expect(r).toEqual(NOT_FOUND)],
  // PR3b: 画像のキーを書く唯一の関数と、削除の前にキーを集める関数
  setVariantImage: [
    (d) => admin.setVariantImage(d, OWNER_B, a.variant, `images/${"0".repeat(32)}.png`),
    (r) => expect(r).toEqual(NOT_FOUND),
  ],
  imageKeysUnder: [
    (d) => admin.imageKeysUnder(d, OWNER_B, { siteId: a.site }),
    (r) => expect(r).toEqual({ ok: true, value: [] }),
  ],
};

/** PR3b: R2 に触るデータ層(`images.ts`)。🔴 R2 の中身も変わらないことを見る */
type ImageCase = (env: { DB: D1Database; IMAGES: TestD1["images"] }) => Promise<unknown>;
const IMAGE_CASES: Record<string, [ImageCase, Expect]> = {
  storeVariantImage: [
    (env) => images.storeVariantImage(env, OWNER_B, a.variant, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }),
    (r) => expect(r).toEqual(NOT_FOUND),
  ],
  removeVariantImage: [(env) => images.removeVariantImage(env, OWNER_B, a.variant), (r) => expect(r).toEqual(NOT_FOUND)],
  deleteSiteWithImages: [(env) => images.deleteSiteWithImages(env, OWNER_B, a.site), (r) => expect(r).toEqual(NOT_FOUND)],
  deletePopupWithImages: [(env) => images.deletePopupWithImages(env, OWNER_B, a.popup), (r) => expect(r).toEqual(NOT_FOUND)],
  deleteVariantWithImages: [
    (env) => images.deleteVariantWithImages(env, OWNER_B, a.variant),
    (r) => expect(r).toEqual(NOT_FOUND),
  ],
};

// 1x1 の PNG(画像の置き場の検査に使う)
const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (ch) => ch.charCodeAt(0),
);

const TABLES = ["sites", "site_allowed_origins", "popups", "popup_triggers", "variants", "events"] as const;

async function r2Keys(): Promise<string[]> {
  return (await t.images.list()).objects.map((o) => o.key).sort();
}

async function snapshotOfA(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    out[table] = (await db.prepare(`select * from ${table} where owner_id = ?1 order by rowid`).bind(OWNER_A).all()).results;
  }
  return out;
}

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  value(await admin.ensureOwner(db, OWNER_A));
  a.site = value(await admin.createSite(db, OWNER_A, { name: "A", allowedOrigins: ["https://lp.example.com"] })).id;
  a.popup = value(await admin.createPopup(db, OWNER_A, a.site, { name: "A" })).id;
  a.archivedPopup = value(await admin.createPopup(db, OWNER_A, a.site, { name: "A アーカイブ" })).id;
  value(await admin.archivePopup(db, OWNER_A, a.archivedPopup));
  const input = { ...variantInput, destinationUrl: "https://offer.example.com/" };
  a.variant = value(await admin.createVariant(db, OWNER_A, a.popup, input)).id;
  a.archivedVariant = value(await admin.createVariant(db, OWNER_A, a.popup, input)).id;
  value(await admin.archiveVariant(db, OWNER_A, a.archivedVariant));
  value(await admin.activatePopup(db, OWNER_A, a.popup));
  // A のパターンに画像を1枚(B から消されない・差し替えられないことを見るため)
  value(await images.storeVariantImage({ DB: db, IMAGES: t.images }, OWNER_A, a.variant, { bytes: TINY_PNG, contentType: "image/png", ext: "png" }));
});
afterAll(async () => {
  await t?.dispose();
});

describe("所有者の分離(データ層の全関数)", () => {
  it("🔴 撃ち方の一覧が、データ層の公開関数ちょうどを覆っている(足し忘れると落ちる)", () => {
    const exported = Object.entries(admin)
      .filter(([, v]) => typeof v === "function")
      .map(([name]) => name)
      .sort();
    expect(exported.length, "関数が1本も見えない = 何も測っていない").toBeGreaterThan(0);
    expect(Object.keys(CASES).sort()).toEqual(exported);
  });

  it("🔴 公開関数はすべて、2つ目の引数に ownerId を取る(規則①)", () => {
    for (const [name, fn] of Object.entries(admin)) {
      if (typeof fn !== "function") continue;
      const params = /^[^(]*\(([^)]*)\)/.exec(fn.toString())?.[1] ?? "";
      expect(params.split(",").map((p) => p.trim())[1], name).toBe("ownerId");
    }
  });

  it("🔴🔴 B として A の行を指すと、全関数が 0件 / 見つからない / 外部キーの断りになり、A の行は1バイトも変わらない", async () => {
    const before = await snapshotOfA();
    expect(before.sites.length, "A の行が無い = 何も測っていない").toBeGreaterThan(0);
    expect(before.variants.length).toBeGreaterThan(0);
    for (const [name, [run, check]] of Object.entries(CASES)) {
      const result = await run(db);
      try {
        await check(result);
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(await snapshotOfA()).toEqual(before);
  });

  it("🔴 画像(R2)のデータ層も、公開関数を全部撃つ。A の行も R2 の中身も変わらない", async () => {
    const exported = Object.entries(images)
      .filter(([, v]) => typeof v === "function")
      .map(([name]) => name)
      .sort();
    expect(Object.keys(IMAGE_CASES).sort()).toEqual(exported);
    const before = await snapshotOfA();
    const keysBefore = await r2Keys();
    expect(keysBefore.length, "A の画像が無い = 何も測っていない").toBe(1);
    for (const [name, [run, check]] of Object.entries(IMAGE_CASES)) {
      const result = await run({ DB: db, IMAGES: t.images });
      try {
        await check(result);
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(await snapshotOfA()).toEqual(before);
    expect(await r2Keys()).toEqual(keysBefore);
  });

  it("✅ A 自身が呼ぶと、同じ関数は A の行を返す(締めすぎていない)", async () => {
    expect((await admin.getSite(db, OWNER_A, a.site)).ok).toBe(true);
    expect((await admin.getPopup(db, OWNER_A, a.popup)).ok).toBe(true);
    expect((await admin.getVariant(db, OWNER_A, a.variant)).ok).toBe(true);
    expect((await admin.listTriggers(db, OWNER_A, a.popup)) as { value: unknown[] }).toMatchObject({ ok: true });
    expect(((await admin.listTriggers(db, OWNER_A, a.popup)) as { value: unknown[] }).value).toHaveLength(6);
  });
});
