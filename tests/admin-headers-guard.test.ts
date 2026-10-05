// @vitest-environment node
//
// `scripts/admin-headers-guard.mjs`(deploy 前に CSP の有無を見る検査)の判定そのものを固定する。
// 🔴 「落ちる例」(CSP が無い out/_headers・unsafe-inline が混ざった out/_headers)と
//   「通る例」(実物の build が作る out/_headers)の両方を見る。
import { describe, expect, it } from "vitest";
import { buildAdminHeadersFile } from "../scripts/build-admin-headers.mjs";
import { headersGuardProblems } from "../scripts/admin-headers-guard.mjs";

const SAMPLE_HTML_WITH_INLINE_SCRIPT = `<html><body><script>const x = 1;</script></body></html>`;

describe("headersGuardProblems", () => {
  it("通る例: 実物の build-admin-headers.mjs が作る _headers には問題が無い", () => {
    const content = buildAdminHeadersFile({
      htmlContents: [SAMPLE_HTML_WITH_INLINE_SCRIPT],
      deliveryOrigin: "https://adpop-delivery.example.workers.dev",
    });
    expect(headersGuardProblems(content)).toEqual([]);
  });

  it("落ちる例: CSP の行が無い(next build だけで止めた out/ を想定)", () => {
    const content = ["/*", "  X-Content-Type-Options: nosniff", "  X-Frame-Options: DENY", ""].join("\n");
    const problems = headersGuardProblems(content);
    expect(problems.some((p) => p.includes("Content-Security-Policy"))).toBe(true);
  });

  it("落ちる例: 空ファイル", () => {
    expect(headersGuardProblems("").length).toBeGreaterThan(0);
  });

  it("落ちる例: script-src に unsafe-inline が混ざっている", () => {
    const content = [
      "/*",
      "  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'",
      "  X-Content-Type-Options: nosniff",
      "  X-Frame-Options: DENY",
      "",
    ].join("\n");
    const problems = headersGuardProblems(content);
    expect(problems.some((p) => p.includes("unsafe-inline"))).toBe(true);
  });

  it("落ちる例: X-Frame-Options が無い", () => {
    const content = [
      "/*",
      "  Content-Security-Policy: default-src 'none'; script-src 'self'",
      "  X-Content-Type-Options: nosniff",
      "",
    ].join("\n");
    const problems = headersGuardProblems(content);
    expect(problems.some((p) => p.includes("X-Frame-Options"))).toBe(true);
  });
});
