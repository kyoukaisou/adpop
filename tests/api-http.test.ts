// @vitest-environment node
//
// 配信エンドポイントの入口の**判定だけ**の検査(`src/lib/api/http.ts`)。
// ⚠ 認可(サイトキー × Origin × 許可ドメイン)は DB の関数が持つので、ここでは1つも測らない。
import { describe, expect, it } from "vitest";
import {
  corsHeaders,
  MAX_EVENT_BODY_BYTES,
  originProblem,
  parseJsonObject,
  readBodyWithLimit,
  siteKeyProblem,
} from "@/lib/api/http";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // ⚠ わざと分割して流す(1チャンクで届く前提を作らない)
      const half = Math.ceil(bytes.byteLength / 2);
      controller.enqueue(bytes.slice(0, half));
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  });
}

describe("Origin", () => {
  it("🔴 無ければ断る(fail-closed)", () => {
    expect(originProblem(null)).toEqual({ status: 403, reason: "origin" });
    expect(originProblem("")).toEqual({ status: 403, reason: "origin" });
  });

  it("長すぎるものは断る", () => {
    expect(originProblem(`https://${"a".repeat(400)}.example.com`)?.status).toBe(403);
  });

  it("✅ 普通の Origin は通す(形の判定は DB がする)", () => {
    expect(originProblem("https://lp.example.com")).toBeNull();
    // ⚠ ここを通ることは「正しい」を1ミリも意味しない —— 形は DB の関数が見る
    expect(originProblem("not-an-origin")).toBeNull();
  });
});

describe("サイトキー", () => {
  it("無い / 長すぎるものは断る", () => {
    expect(siteKeyProblem(null)).toEqual({ status: 400, reason: "site_key" });
    expect(siteKeyProblem("")).toEqual({ status: 400, reason: "site_key" });
    expect(siteKeyProblem("a".repeat(65))?.status).toBe(400);
  });

  it("✅ 32桁の16進は通す", () => {
    expect(siteKeyProblem("0123456789abcdef0123456789abcdef")).toBeNull();
  });
});

describe("本文の読み取り(上限つき)", () => {
  it("✅ 上限より小さければ読める(分割して届いても連結する)", async () => {
    const text = JSON.stringify({ kind: "fire", popupKey: "p".repeat(32) });
    expect(await readBodyWithLimit(streamOf(text), MAX_EVENT_BODY_BYTES)).toEqual({ text });
  });

  it("✅ 上限ちょうどは通る", async () => {
    const text = "a".repeat(64);
    expect(await readBodyWithLimit(streamOf(text), 64)).toEqual({ text });
  });

  it("🔴 1バイト超えたら 413(読み切らずに打ち切る)", async () => {
    const result = await readBodyWithLimit(streamOf("a".repeat(65)), 64);
    expect(result).toEqual({ problem: { status: 413, reason: "body_too_large" } });
  });

  it("🔴 マルチバイトは**文字数ではなくバイト数**で数える", async () => {
    // 「あ」= UTF-8 で3バイト。10文字 = 30バイト
    const result = await readBodyWithLimit(streamOf("あ".repeat(10)), 20);
    expect(result).toEqual({ problem: { status: 413, reason: "body_too_large" } });
  });

  it("本文が無い / 途中で壊れたら断る", async () => {
    expect(await readBodyWithLimit(null)).toEqual({ problem: { status: 400, reason: "body" } });
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    expect(await readBodyWithLimit(broken)).toEqual({ problem: { status: 400, reason: "body" } });
  });
});

describe("JSON の読み取り", () => {
  it("✅ オブジェクトだけを通す", () => {
    expect(parseJsonObject('{"kind":"fire"}')).toEqual({ value: { kind: "fire" } });
  });

  it("🔴 配列・文字列・数値・null は通さない(オブジェクトを期待している場所なので)", () => {
    for (const bad of ["[]", '"文字列"', "42", "null", "", "{壊れている"]) {
      expect(parseJsonObject(bad), bad).toEqual({ problem: { status: 400, reason: "json" } });
    }
  });
});

describe("CORS", () => {
  it("🔴 `*` を返さず、呼んできた Origin をそのまま返し、`Vary: Origin` を必ず付ける", () => {
    expect(corsHeaders("https://lp.example.com")).toEqual({
      "access-control-allow-origin": "https://lp.example.com",
      vary: "Origin",
    });
  });
});
