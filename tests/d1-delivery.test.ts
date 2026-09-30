// @vitest-environment node
//
// 配信の2つの口(src/lib/data/delivery.ts)を、**実物のローカル D1** で測る。
// 旧版の検査を全部移し、**同じ入力に同じ理由で断る**ことを固定する(⚠ 表示 ID の形の違いは delivery.ts の冒頭)。
//
// 🔴 **この束がいちばん守りたいもの**:
//   ① **fail-closed**: サイトキー・Origin・許可ドメイン・稼働中・配れるパターンのどれか1つでも欠けたら何も返さない
//   ② **返す情報が最小**: 内部 id・owner_id・他サイトの情報を1バイトも返さない
//   ③ **page_url は origin + path だけ**(投入側が削ってから入れる)
//   ④ **所有者を呼び出し側から指定できない**
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as admin from "../src/lib/data/admin";
import { recordEvent, siteConfig } from "../src/lib/data/delivery";
import { openTestD1, OWNER_A, OWNER_B, type TestD1 } from "./helpers/d1";

const ORIGIN_A = "https://lp.example.com";
const ORIGIN_B = "https://other.example.com";

let t: TestD1;
let db: D1Database;

const ref = {
  siteIdA: "",
  siteKeyA: "",
  siteKeyB: "",
  siteKeyEmptyOrigins: "",
  siteKeyNoActive: "",
  popupIdA: "",
  popupKeyA: "",
  popupKeyB: "",
  variantIdA: "",
  variantIdA2: "",
  variantKeyA: "",
  variantKeyA2: "",
  variantKeyB: "",
};

function value<T>(result: admin.Result<T>): T {
  if (!result.ok) throw new Error(`準備に失敗: ${JSON.stringify(result.failure)}`);
  return result.value;
}

async function siteKeyOf(siteId: string): Promise<string> {
  return (await db.prepare("select site_key from sites where id = ?1").bind(siteId).first<{ site_key: string }>())!
    .site_key;
}
async function popupKeyOf(popupId: string): Promise<string> {
  return (await db.prepare("select public_key from popups where id = ?1").bind(popupId).first<{ public_key: string }>())!
    .public_key;
}
async function variantKeyOf(variantId: string): Promise<string> {
  return (await db.prepare("select public_key from variants where id = ?1").bind(variantId).first<{ public_key: string }>())!
    .public_key;
}

const text = (headline: string) => ({ headline, body: "", buttonLabel: "" });

beforeAll(async () => {
  t = await openTestD1();
  db = t.db;
  value(await admin.ensureOwner(db, OWNER_A));
  value(await admin.ensureOwner(db, OWNER_B));

  ref.siteIdA = value(await admin.createSite(db, OWNER_A, { name: "A の LP", allowedOrigins: [ORIGIN_A] })).id;
  const empty = value(await admin.createSite(db, OWNER_A, { name: "許可空", allowedOrigins: [] })).id;
  const noActive = value(await admin.createSite(db, OWNER_A, { name: "稼働なし", allowedOrigins: [ORIGIN_A] })).id;
  const siteB = value(await admin.createSite(db, OWNER_B, { name: "B の LP", allowedOrigins: [ORIGIN_B] })).id;

  ref.popupIdA = value(await admin.createPopup(db, OWNER_A, ref.siteIdA, { name: "A" })).id;
  const popupEmpty = value(await admin.createPopup(db, OWNER_A, empty, { name: "許可空" })).id;
  value(await admin.createPopup(db, OWNER_A, noActive, { name: "下書き" }));
  const popupB = value(await admin.createPopup(db, OWNER_B, siteB, { name: "B" })).id;

  ref.variantIdA = value(
    await admin.createVariant(db, OWNER_A, ref.popupIdA, {
      kind: "text",
      content: text("まだ間に合います"),
      destinationUrl: "https://offer.example.com/a",
    }),
  ).id;
  ref.variantIdA2 = value(
    await admin.createVariant(db, OWNER_A, ref.popupIdA, {
      kind: "text",
      content: text("もう1つの案"),
      destinationUrl: "https://offer.example.com/b",
    }),
  ).id;
  // 重みの編集は PR5。ここでは配信が重みをそのまま返すことだけを見る
  await db.prepare("update variants set weight = 60, content = ?2 where id = ?1")
    .bind(ref.variantIdA, JSON.stringify({ headline: "まだ間に合います" })).run();
  await db.prepare("update variants set weight = 40 where id = ?1").bind(ref.variantIdA2).run();
  value(
    await admin.createVariant(db, OWNER_A, popupEmpty, {
      kind: "text",
      content: text("x"),
      destinationUrl: "https://offer.example.com/x",
    }),
  );
  const variantB = value(
    await admin.createVariant(db, OWNER_B, popupB, {
      kind: "text",
      content: text("B"),
      destinationUrl: "https://offer.example.com/bb",
    }),
  ).id;

  value(await admin.activatePopup(db, OWNER_A, ref.popupIdA));
  // 許可ドメインが空のサイトでも「稼働中」にはできる(配信はされない)
  await db.prepare("update popups set status = 'active' where id = ?1").bind(popupEmpty).run();
  value(await admin.activatePopup(db, OWNER_B, popupB));

  ref.siteKeyA = await siteKeyOf(ref.siteIdA);
  ref.siteKeyB = await siteKeyOf(siteB);
  ref.siteKeyEmptyOrigins = await siteKeyOf(empty);
  ref.siteKeyNoActive = await siteKeyOf(noActive);
  ref.popupKeyA = await popupKeyOf(ref.popupIdA);
  ref.popupKeyB = await popupKeyOf(popupB);
  ref.variantKeyA = await variantKeyOf(ref.variantIdA);
  ref.variantKeyA2 = await variantKeyOf(ref.variantIdA2);
  ref.variantKeyB = await variantKeyOf(variantB);
});

afterAll(async () => {
  await t?.dispose();
});

const config = (siteKey: string, origin: string) => siteConfig(db, siteKey, origin);
const record = (siteKey: string, origin: string, event: Record<string, unknown>) =>
  recordEvent(db, siteKey, origin, event);

describe("配信: siteConfig", () => {
  it("✅ 許可ドメインから引くと、いま有効なポップの設定が返る", async () => {
    const c = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(c.v).toBe(1);
    expect(c.popup.key).toBe(ref.popupKeyA);
    expect(c.popup.minDisplayDelaySeconds).toBe(3);
    expect(c.popup.frequency).toEqual({ suppressDays: 7, sessionImpressions: 1, postConversionDays: 30 });
  });

  it("🔴 内部 id・owner_id・他サイトの情報を1バイトも返さない", async () => {
    const raw = JSON.stringify(await config(ref.siteKeyA, ORIGIN_A));
    for (const [label, secret] of [
      ["owner_id", OWNER_A],
      ["site の内部 id", ref.siteIdA],
      ["popup の内部 id", ref.popupIdA],
      ["variant の内部 id", ref.variantIdA],
      ["他サイトの公開キー", ref.siteKeyB],
      ["他サイトのポップ", ref.popupKeyB],
      ["他サイトのバリアント", ref.variantKeyB],
    ] as const) {
      expect(raw.includes(secret), `${label} が配信の応答に混ざっている`).toBe(false);
    }
    expect(raw).not.toMatch(/owner/i);
  });

  it("有効なトリガだけが、既定値(要件書 §4-2)のまま、旧版と同じ順で返る", async () => {
    const c = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(c.popup.triggers).toEqual([
      { kind: "back", threshold: null },
      { kind: "exit_intent", threshold: null },
    ]);
  });

  it("バリアントは重みと中身つきで、決定的な順序で返る(割り当ては PR5)", async () => {
    const first = (await config(ref.siteKeyA, ORIGIN_A))!;
    const second = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(first.popup.variants.map((v) => v.key).sort()).toEqual([ref.variantKeyA, ref.variantKeyA2].sort());
    expect(second.popup.variants.map((v) => v.key)).toEqual(first.popup.variants.map((v) => v.key));
    expect(first.popup.variants.find((v) => v.key === ref.variantKeyA)).toEqual({
      key: ref.variantKeyA,
      kind: "text",
      weight: 60,
      content: { headline: "まだ間に合います" },
      destinationUrl: "https://offer.example.com/a",
    });
  });

  describe("🔴 fail-closed(1つでも合わなければ null)", () => {
    it.each([
      ["許可していない Origin", () => config(ref.siteKeyA, ORIGIN_B)],
      ["Origin の形が違う", () => config(ref.siteKeyA, "https://lp.example.com/path")],
      ["Origin が空文字", () => config(ref.siteKeyA, "")],
      ["Origin の大文字違い(許可ドメインは小文字で保存)", () => config(ref.siteKeyA, "https://LP.example.com")],
      ["サイトキーの形が違う", () => config("not-a-site-key", ORIGIN_A)],
      ["実在しないサイトキー", () => config("0".repeat(32), ORIGIN_A)],
      ["許可ドメインが空のサイト", () => config(ref.siteKeyEmptyOrigins, ORIGIN_A)],
      ["稼働中のポップが無いサイト", () => config(ref.siteKeyNoActive, ORIGIN_A)],
    ])("%s → null", async (_label, run) => {
      expect(await run()).toBeNull();
    });

    it("🔴 配れるパターンが1つも無いポップは配らない", async () => {
      await db.prepare("update variants set archived_at = '2026-01-01T00:00:00.000Z' where popup_id = ?1").bind(ref.popupIdA).run();
      try {
        expect(await config(ref.siteKeyA, ORIGIN_A)).toBeNull();
      } finally {
        await db.prepare("update variants set archived_at = null where popup_id = ?1").bind(ref.popupIdA).run();
      }
    });
  });

  it.each([
    ["アーカイブしたパターン", "update variants set archived_at = '2026-01-01T00:00:00.000Z' where id = ?1", "update variants set archived_at = null where id = ?1"],
    ["画像型のパターン(埋め込みがまだ描けない = PR4)", "update variants set kind = 'image' where id = ?1", "update variants set kind = 'text' where id = ?1"],
    ["🕐 chatbot のパターン(v1.1)", "update variants set kind = 'chatbot' where id = ?1", "update variants set kind = 'text' where id = ?1"],
  ])("🔴 %s は配らない", async (_label, breakSql, restoreSql) => {
    await db.prepare(breakSql).bind(ref.variantIdA2).run();
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      expect(c.popup.variants.map((v) => v.key)).toEqual([ref.variantKeyA]);
    } finally {
      await db.prepare(restoreSql).bind(ref.variantIdA2).run();
    }
  });

  it("🔴 `content` に無関係な鍵を入れても、配信の応答には出ない(出てよい鍵の集合ちょうど)", async () => {
    await db.prepare("update variants set content = ?2 where id = ?1").bind(
      ref.variantIdA,
      JSON.stringify({ headline: "見出し", body: "本文", buttonLabel: "押す", internalNote: "社外秘", ownerEmail: "a@example.test", imageKey: "images/x.png" }),
    ).run();
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      const variant = c.popup.variants.find((v) => v.key === ref.variantKeyA)!;
      expect(Object.keys(variant.content).sort()).toEqual(["body", "buttonLabel", "headline"]);
      expect(JSON.stringify(c)).not.toContain("社外秘");
      expect(JSON.stringify(c)).not.toContain("a@example.test");
    } finally {
      await db.prepare("update variants set content = ?2 where id = ?1").bind(ref.variantIdA, JSON.stringify({ headline: "まだ間に合います" })).run();
    }
  });

  it("⚠ 空の `content` は空のまま返る(null を詰めない)", async () => {
    await db.prepare("update variants set content = '{}' where id = ?1").bind(ref.variantIdA).run();
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      expect(c.popup.variants.find((v) => v.key === ref.variantKeyA)!.content).toEqual({});
    } finally {
      await db.prepare("update variants set content = ?2 where id = ?1").bind(ref.variantIdA, JSON.stringify({ headline: "まだ間に合います" })).run();
    }
  });
});

describe("投入: recordEvent", () => {
  let counter = 0;
  const nextImpression = () => {
    counter += 1;
    return `aaaaaaaa-0000-0000-0000-${String(counter).padStart(12, "0")}`;
  };
  const base = () => ({
    popupKey: ref.popupKeyA,
    variantKey: ref.variantKeyA,
    device: "mobile",
    visitorHash: "0123456789abcdef0123456789abcdef",
  });
  const storedPageUrl = async (impressionId: string) =>
    (
      await db
        .prepare("select page_url from events where impression_id = ?1 and kind = 'impression'")
        .bind(impressionId)
        .first<{ page_url: string | null }>()
    )?.page_url ?? null;

  it("✅ 表示イベントが入る", async () => {
    const impressionId = nextImpression();
    expect(
      await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId,
        pageUrl: `${ORIGIN_A}/lp/a`,
      }),
    ).toEqual({ ok: true, stored: true });
    expect(await storedPageUrl(impressionId)).toBe(`${ORIGIN_A}/lp/a`);
  });

  it("🔴 page_url は query と fragment を削ってから入る(要件書 §6 裁定4)", async () => {
    for (const [sent, expected] of [
      [`${ORIGIN_A}/lp?email=taro%40example.com`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}/lp?utm_source=x#anchor`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}/lp#anchor?x=1`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}?a=1`, ORIGIN_A],
      [`${ORIGIN_A}/@handle`, `${ORIGIN_A}/@handle`],
    ] as const) {
      const impressionId = nextImpression();
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId,
        pageUrl: sent,
      });
      expect(r.ok, `${sent} が断られた`).toBe(true);
      expect(await storedPageUrl(impressionId), `${sent} の削り方`).toBe(expected);
    }
  });

  it("🔴 削っても形が合わない URL は断る(黙って null にして通さない)", async () => {
    for (const bad of [
      "https://taro@example.com/path",
      "lp.example.com/a",
      "https://lp.example.com/a b",
      "javascript:alert(1)",
    ]) {
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId: nextImpression(),
        pageUrl: bad,
      });
      expect(r, `${bad} が通った`).toEqual({ ok: false, reason: "pageUrl" });
    }
  });

  it("🔴 表示と閉じるは同じ impression_id で二重に増えない(stored=false は断りではない)", async () => {
    const impressionId = nextImpression();
    const impression = { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId };
    expect(await record(ref.siteKeyA, ORIGIN_A, impression)).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, impression)).toEqual({ ok: true, stored: false });
    const close = { ...base(), kind: "close", impressionId, closeReason: "esc" };
    expect(await record(ref.siteKeyA, ORIGIN_A, close)).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, close)).toEqual({ ok: true, stored: false });
    const c = await db.prepare("select count(*) as c from events where impression_id = ?1").bind(impressionId).first<{ c: number }>();
    expect(c?.c).toBe(2);
  });

  it("クリックは同じ表示に何度でも入る(CTR はダッシュボードで畳む)", async () => {
    const impressionId = nextImpression();
    await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId });
    for (let i = 0; i < 2; i += 1) {
      expect(await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "click", impressionId })).toEqual({
        ok: true,
        stored: true,
      });
    }
  });

  it("✅ 発火と抑制はパターンも表示 ID も無しで入る", async () => {
    for (const kind of ["fire", "suppressed"]) {
      expect(
        await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "desktop", kind, triggerKind: "exit_intent" }),
        kind,
      ).toEqual({ ok: true, stored: true });
    }
  });

  describe("🔴 断り(どの理由で断ったかまで固定する)", () => {
    it.each([
      // 🔴 サイトと Origin の断りは1つの理由(サイトキーの実在を判別させない)
      ["サイトキーの形", () => record("not-a-key", ORIGIN_A, { ...base(), kind: "fire" }), "not_allowed"],
      ["実在しないサイト", () => record("0".repeat(32), ORIGIN_A, { ...base(), kind: "fire" }), "not_allowed"],
      ["許可していない Origin", () => record(ref.siteKeyA, ORIGIN_B, { ...base(), kind: "fire" }), "not_allowed"],
      ["Origin の形", () => record(ref.siteKeyA, "lp.example.com", { ...base(), kind: "fire" }), "not_allowed"],
      ["許可ドメインが空のサイト", () => record(ref.siteKeyEmptyOrigins, ORIGIN_A, { ...base(), kind: "fire" }), "not_allowed"],
      ["実在しないポップ", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), popupKey: "0".repeat(32), kind: "fire" }), "popup"],
      ["ポップの指定が無い", () => record(ref.siteKeyA, ORIGIN_A, { device: "mobile", kind: "fire" }), "popup"],
      ["端末が2値でない", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), device: "tablet", kind: "fire" }), "shape"],
      ["知らない kind", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "unknown" }), "kind"],
      ["匿名IDの形", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), visitorHash: "taro@example.com", kind: "fire" }), "visitorHash"],
      [
        "表示 ID が uuid でない",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId: "not-a-uuid" }),
        "impressionId",
      ],
      [
        "表示なのにトリガ種別が無い",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "impression", impressionId: "aaaaaaaa-9999-0000-0000-000000000001" }),
        "shape",
      ],
      [
        "閉じるなのに理由が無い",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "close", impressionId: "aaaaaaaa-9999-0000-0000-000000000002" }),
        "shape",
      ],
      ["知らないトリガ種別", () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "fire", triggerKind: "hover" }), "shape"],
      ["イベントが JSON のオブジェクトでない", () => record(ref.siteKeyA, ORIGIN_A, "文字列" as never), "event"],
    ])("%s → 断る", async (_label, run, reason) => {
      expect(await run()).toEqual({ ok: false, reason });
    });

    it("🔴 CV(conversion)はこの口では受けない(CV 計測タグは PR6 の別の入口)", async () => {
      expect(await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "conversion" })).toEqual({ ok: false, reason: "kind" });
    });

    it("🔴 値が JSON の文字列でなければ断る(数値や真偽値を文字列として通さない)", async () => {
      for (const bad of [
        { visitorHash: 12345678901234567890123456789012 },
        { popupKey: 123 },
        { kind: ["fire"] },
        { device: null },
        { pageUrl: { a: 1 } },
      ]) {
        expect(
          await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "mobile", kind: "fire", ...bad }),
          `${JSON.stringify(bad)} が通った`,
        ).toEqual({ ok: false, reason: "types" });
      }
    });

    it("本文が 4KB を超えたら断る / ✅ 4KB 以内なら通る", async () => {
      expect(
        await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "mobile", kind: "fire", pageUrl: `${ORIGIN_A}/${"a".repeat(5000)}` }),
      ).toEqual({ ok: false, reason: "too_large" });
      expect(
        (await record(ref.siteKeyA, ORIGIN_A, { popupKey: ref.popupKeyA, device: "mobile", kind: "fire", pageUrl: `${ORIGIN_A}/${"a".repeat(1000)}` })).ok,
      ).toBe(true);
    });
  });

  describe("🔴 他人のサイトへ書けない", () => {
    it("他サイトのポップの識別子を渡しても、そのサイトの行にならない", async () => {
      expect(await record(ref.siteKeyA, ORIGIN_A, { ...base(), popupKey: ref.popupKeyB, kind: "fire" })).toEqual({
        ok: false,
        reason: "popup",
      });
    });

    it("他ポップのパターンの識別子を渡しても解決しない", async () => {
      expect(
        await record(ref.siteKeyA, ORIGIN_A, {
          ...base(),
          variantKey: ref.variantKeyB,
          kind: "impression",
          triggerKind: "exit_intent",
          impressionId: nextImpression(),
        }),
      ).toEqual({ ok: false, reason: "variant" });
    });

    it("✅ 入った行は、全部そのサイトの owner のもの(所有者を呼び出し側から指定できない)", async () => {
      await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "fire", ownerId: OWNER_B, siteId: "x" });
      const rows = await db.prepare("select distinct owner_id, site_id from events").all<{ owner_id: string; site_id: string }>();
      expect(rows.results.length, "1行も入っていない = 何も測っていない").toBeGreaterThan(0);
      for (const row of rows.results) {
        expect(row.owner_id).toBe(OWNER_A);
        expect(row.site_id).toBe(ref.siteIdA);
      }
    });
  });

  it("🔴 重複排除はサイトの中だけ(他サイトが同じ表示 ID を先に入れても、こちらは落ちない)", async () => {
    const shared = "dddddddd-0000-0000-0000-000000000001";
    const mine = { ...base(), kind: "impression", triggerKind: "exit_intent", impressionId: shared };
    expect(await record(ref.siteKeyA, ORIGIN_A, mine)).toEqual({ ok: true, stored: true });
    expect(
      await record(ref.siteKeyB, ORIGIN_B, {
        popupKey: ref.popupKeyB,
        variantKey: ref.variantKeyB,
        device: "mobile",
        kind: "impression",
        triggerKind: "exit_intent",
        impressionId: shared,
      }),
    ).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, mine)).toEqual({ ok: true, stored: false });
  });
});
