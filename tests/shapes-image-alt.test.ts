// @vitest-environment node
//
// 🔴 `requiresImageAlt`(画像の説明の必須判定)が、欠落値に対して fail-open にならないことを固定する
//   (Codex #8 1巡目 Blocker 3)。保存 API の入口(body.ts)とデータ層(admin.ts)は**この同じ関数**を
//   呼ぶので、ここで1か所を撃てば両方の関門を守ったことになる。
import { describe, expect, it } from "vitest";
import { normalizeToText, requiresImageAlt } from "../src/lib/data/shapes";

describe("normalizeToText(欠落・null・非文字列・空白だけ → すべて空扱い)", () => {
  it.each([
    [undefined, ""],
    [null, ""],
    [42, ""],
    [{}, ""],
    ["", ""],
    ["   ", ""],
    ["  商品説明  ", "商品説明"],
    ["商品説明", "商品説明"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeToText(input)).toBe(expected);
  });
});

describe("requiresImageAlt(画像型・ボタン文言が空のときだけ必須)", () => {
  it.each([
    ["content が空オブジェクト(欠落)", { kind: "image", content: {} }],
    ["buttonLabel/imageAlt が null", { kind: "image", content: { buttonLabel: null, imageAlt: null } }],
    ["buttonLabel/imageAlt が非文字列(数値)", { kind: "image", content: { buttonLabel: 42, imageAlt: 42 } }],
    ["buttonLabel/imageAlt が空白だけ", { kind: "image", content: { buttonLabel: "   ", imageAlt: "\t\n" } }],
    [
      "以前の3フィールド形式(imageAlt キー自体が無い。PR4a 以前に保存された画像型を模す)",
      { kind: "image", content: { headline: "x", body: "y", buttonLabel: "" } },
    ],
    ["content 自体が無い", { kind: "image" }],
  ])("🔴 %s → 必須(true)", (_label, input) => {
    expect(requiresImageAlt(input)).toBe(true);
  });

  it.each([
    ["buttonLabel があれば imageAlt が空でもよい", { kind: "image", content: { buttonLabel: "詳しく見る", imageAlt: "" } }],
    ["imageAlt があれば buttonLabel が空でもよい", { kind: "image", content: { buttonLabel: "", imageAlt: "商品の写真" } }],
    ["両方とも空白を含むが中身がある", { kind: "image", content: { buttonLabel: " 押す ", imageAlt: "" } }],
  ])("✅ %s → 必須ではない(false)", (_label, input) => {
    expect(requiresImageAlt(input)).toBe(false);
  });

  it("⚠ text 型では、content がどんな形でも必須にならない", () => {
    expect(requiresImageAlt({ kind: "text", content: {} })).toBe(false);
    expect(requiresImageAlt({ kind: "text" })).toBe(false);
  });
});
