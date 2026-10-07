// @vitest-environment node
//
// `scripts/admin-headers-guard.mjs`(deploy 前に CSP の形・配信元の埋め込みを見る検査)の
// 判定そのものを固定する。
// 🔴 「落ちる例」(CSP が無い out/_headers・unsafe-inline が混ざった out/_headers・
//   `/*` 以外のパスだけに正しいヘッダがある out/_headers・img-src に渡した配信元が無い・
//   ビルド出力に配信元の文字列が埋め込まれていない)と「通る例」(実物の生成関数の出力)の両方を見る。
//
// ⚠ 「渡された配信元が本当に確定した値と一致しているか」は、この検査の責務ではない
// (`scripts/delivery-origin-guard.mjs` / `tests/delivery-origin-guard.test.ts` を見る)。
import { describe, expect, it } from "vitest";
import { buildAdminHeadersFile } from "../scripts/build-admin-headers.mjs";
import { deliveryOriginEmbeddedProblems, headersGuardProblems, parseHeaderBlocks } from "../scripts/admin-headers-guard.mjs";

const SAMPLE_HTML_WITH_INLINE_SCRIPT = `<html><body><script>const x = 1;</script></body></html>`;
const ORIGIN = "https://adpop-delivery.myaccount.workers.dev";

function buildRealHeaders(deliveryOrigin: string | undefined) {
  return buildAdminHeadersFile({
    htmlContents: [SAMPLE_HTML_WITH_INLINE_SCRIPT],
    deliveryOrigin,
  });
}

describe("parseHeaderBlocks", () => {
  it("非インデント行でルールを区切り、インデント行をそのルールのヘッダとして拾う", () => {
    const content = ["/*", "  A: 1", "  B: 2", "/embed/*", "  C: 3", ""].join("\n");
    expect(parseHeaderBlocks(content)).toEqual([
      { path: "/*", headers: { A: "1", B: "2" } },
      { path: "/embed/*", headers: { C: "3" } },
    ]);
  });
});

describe("headersGuardProblems", () => {
  it("通る例: 実物の build-admin-headers.mjs が作る _headers(配信元つき)には問題が無い", () => {
    const content = buildRealHeaders(ORIGIN);
    expect(headersGuardProblems({ headersContent: content, deliveryOrigin: ORIGIN })).toEqual([]);
  });

  it("🔴 落ちる例: 配信元を渡さない(空文字)ときも検査を省略しない(レビュー指摘)", () => {
    const content = buildRealHeaders(undefined);
    const problems = headersGuardProblems({ headersContent: content, deliveryOrigin: "" });
    expect(problems.some((p) => p.includes("渡されていない"))).toBe(true);
  });

  it("落ちる例: `/*` のルールが無い(next build だけで止めた out/ を想定)", () => {
    const problems = headersGuardProblems({ headersContent: "", deliveryOrigin: ORIGIN });
    expect(problems.some((p) => p.includes("`/*`"))).toBe(true);
  });

  it("落ちる例: CSP の行が無い", () => {
    const content = [
      "/*",
      "  X-Content-Type-Options: nosniff",
      "  X-Frame-Options: DENY",
      "  Referrer-Policy: no-referrer",
      "",
    ].join("\n");
    const problems = headersGuardProblems({ headersContent: content, deliveryOrigin: ORIGIN });
    expect(problems.some((p) => p.includes("Content-Security-Policy"))).toBe(true);
  });

  it("落ちる例: script-src に unsafe-inline が混ざっている", () => {
    const content = [
      "/*",
      "  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self' blob: " +
        ORIGIN,
      "  X-Content-Type-Options: nosniff",
      "  X-Frame-Options: DENY",
      "  Referrer-Policy: no-referrer",
      "",
    ].join("\n");
    const problems = headersGuardProblems({ headersContent: content, deliveryOrigin: ORIGIN });
    expect(problems.some((p) => p.includes("unsafe-inline"))).toBe(true);
  });

  it("落ちる例: X-Frame-Options / Referrer-Policy が無い", () => {
    const content = [
      "/*",
      "  Content-Security-Policy: default-src 'none'; script-src 'self'; img-src 'self' blob: " + ORIGIN,
      "  X-Content-Type-Options: nosniff",
      "",
    ].join("\n");
    const problems = headersGuardProblems({ headersContent: content, deliveryOrigin: ORIGIN });
    expect(problems.some((p) => p.includes("X-Frame-Options"))).toBe(true);
    expect(problems.some((p) => p.includes("Referrer-Policy"))).toBe(true);
  });

  it("🔴 落ちる例: `/*` 以外のパスだけに正しいヘッダがあっても合格にしない(実際に全画面へ効くルールを見る)", () => {
    const content = [
      "/*",
      "  X-Content-Type-Options: nosniff",
      "/sites",
      "  Content-Security-Policy: default-src 'none'; script-src 'self'; img-src 'self' blob: " + ORIGIN,
      "  X-Frame-Options: DENY",
      "  Referrer-Policy: no-referrer",
      "",
    ].join("\n");
    const problems = headersGuardProblems({ headersContent: content, deliveryOrigin: ORIGIN });
    expect(problems.some((p) => p.includes("Content-Security-Policy"))).toBe(true);
  });

  it("🔴 落ちる例: img-src に渡した配信元がトークンとして入っていない(CSP が別の値を持つ想定)", () => {
    const content = [
      "/*",
      "  Content-Security-Policy: default-src 'none'; script-src 'self'; img-src 'self' blob: https://old.example.com",
      "  X-Content-Type-Options: nosniff",
      "  X-Frame-Options: DENY",
      "  Referrer-Policy: no-referrer",
      "",
    ].join("\n");
    const problems = headersGuardProblems({ headersContent: content, deliveryOrigin: ORIGIN });
    expect(problems.some((p) => p.includes("img-src"))).toBe(true);
  });

  it("落ちる例: 空ファイル", () => {
    expect(headersGuardProblems({ headersContent: "", deliveryOrigin: ORIGIN }).length).toBeGreaterThan(0);
  });
});

describe("deliveryOriginEmbeddedProblems", () => {
  it("通る例: 渡した配信元の文字列がビルド出力のどこかに入っている", () => {
    const problems = deliveryOriginEmbeddedProblems({
      deliveryOrigin: ORIGIN,
      fileContents: [`var a="x";var b="${ORIGIN}/img/";`],
    });
    expect(problems).toEqual([]);
  });

  it("🔴 落ちる例: 渡した配信元がビルド出力のどこにも無い(env 無しで next build した想定)", () => {
    const problems = deliveryOriginEmbeddedProblems({
      deliveryOrigin: ORIGIN,
      fileContents: ["var a=1;", "var b=2;"],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("🔴 落ちる例: 配信元を渡さない(空文字)ときも検査を省略しない(レビュー指摘)", () => {
    const problems = deliveryOriginEmbeddedProblems({ deliveryOrigin: "", fileContents: [] });
    expect(problems.some((p) => p.includes("渡されていない"))).toBe(true);
  });
});
