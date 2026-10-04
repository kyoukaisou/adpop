// @vitest-environment node
//
// 🔴 `imageKey` を書けるのは `setVariantImage` だけ(security 監査 M6 の2枚目 = データ層)。
//   型は3欄でも実行時には何でも通るので、`createVariant` / `updateVariant` に余計な鍵を混ぜて呼び、
//   DB の `content` が**3欄 + 元の imageKey** のままであることを見る。
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";

let t: TestD1;
let db: D1Database;
let popupId = "";
const KEY = `images/${"a".repeat(32)}.png`;
const OTHER_KEY = `images/${"b".repeat(32)}.png`;

const contentOf = async (id: string) =>
  JSON.parse((await db.prepare("select content from variants where id = ?1").bind(id).first<{ content: string }>())!.content);

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  await admin.ensureOwner(db, OWNER_A);
  const site = await admin.createSite(db, OWNER_A, { name: "s", allowedOrigins: [] });
  if (!site.ok) throw new Error("準備に失敗");
  const popup = await admin.createPopup(db, OWNER_A, site.value.id, { name: "p" });
  if (!popup.ok) throw new Error("準備に失敗");
  popupId = popup.value.id;
});
afterAll(async () => {
  await t?.dispose();
});

const injected = (headline: string) =>
  ({
    kind: "text",
    content: { headline, body: "", buttonLabel: "", imageKey: OTHER_KEY, extra: "x" },
    destinationUrl: "https://offer.example.com/",
  }) as unknown as admin.VariantInput;

describe("content の組み直し", () => {
  it("🔴 createVariant に余計な鍵を混ぜても、4欄だけが入る", async () => {
    const created = await admin.createVariant(db, OWNER_A, popupId, injected("作る"));
    if (!created.ok) throw new Error("作れない");
    expect(await contentOf(created.value.id)).toEqual({ headline: "作る", body: "", buttonLabel: "", imageAlt: "" });
  });

  it("🔴 updateVariant に imageKey を混ぜても、元の imageKey が残る / 4欄は差し替わる", async () => {
    const created = await admin.createVariant(db, OWNER_A, popupId, injected("前"));
    if (!created.ok) throw new Error("作れない");
    expect(await admin.setVariantImage(db, OWNER_A, created.value.id, KEY)).toEqual({ ok: true, value: { previousKey: null } });
    expect((await admin.updateVariant(db, OWNER_A, created.value.id, injected("後"))).ok).toBe(true);
    expect(await contentOf(created.value.id)).toEqual({ headline: "後", body: "", buttonLabel: "", imageAlt: "", imageKey: KEY });
  });

  it("🔴 画像型・ボタン文言が空で imageAlt も空なら、データ層でも断る(body.ts を経由しない呼び出しへの2枚目の関門)", async () => {
    const bad: admin.VariantInput = {
      kind: "image",
      content: { headline: "", body: "", buttonLabel: "", imageAlt: "" },
      destinationUrl: "https://offer.example.com/",
    };
    expect(await admin.createVariant(db, OWNER_A, popupId, bad)).toEqual({
      ok: false,
      failure: { kind: "invalid", field: "imageAlt" },
    });
    const created = await admin.createVariant(db, OWNER_A, popupId, { ...bad, content: { ...bad.content, imageAlt: "説明" } });
    if (!created.ok) throw new Error("作れない");
    expect(await admin.updateVariant(db, OWNER_A, created.value.id, bad)).toEqual({
      ok: false,
      failure: { kind: "invalid", field: "imageAlt" },
    });
  });

  it("🔴 setVariantImage は形の違うキーを断る / 前のキーを返す / null で外す", async () => {
    const created = await admin.createVariant(db, OWNER_A, popupId, injected("img"));
    if (!created.ok) throw new Error("作れない");
    const id = created.value.id;
    expect(await admin.setVariantImage(db, OWNER_A, id, "../../etc/passwd")).toEqual({
      ok: false,
      failure: { kind: "invalid", field: "imageKey" },
    });
    await admin.setVariantImage(db, OWNER_A, id, KEY);
    expect(await admin.setVariantImage(db, OWNER_A, id, OTHER_KEY)).toEqual({ ok: true, value: { previousKey: KEY } });
    expect(await admin.setVariantImage(db, OWNER_A, id, null)).toEqual({ ok: true, value: { previousKey: OTHER_KEY } });
    expect((await contentOf(id)).imageKey).toBeUndefined();
  });
});
