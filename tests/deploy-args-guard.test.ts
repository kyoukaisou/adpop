// @vitest-environment node
//
// `scripts/deploy-args-guard.mjs`(npm run deploy:delivery / deploy:admin が、追加の CLI 引数を
// 一切受け付けないかを見る検査)の判定そのものを固定する。
// 🔴 レビュー指摘への対応: deploy 前の検査(scripts/check-custom-domain.mjs)は wrangler.*.jsonc だけを
// 読むため、`wrangler deploy --route ... -c wrangler.delivery.jsonc` のように wrangler を直接呼べば
// 検査をすり抜けて zone route を deploy できる(--route/--routes/--domain/--domains は wrangler が
// config の routes を CLI から上書き・追加する)。正規の経路をこの2つの npm script に絞り、
// 追加の引数を一切受け付けないことでこの迂回経路を塞ぐ。
import { describe, expect, it } from "vitest";
import { deployArgsGuardProblems, KNOWN_TARGETS } from "../scripts/deploy-args-guard.mjs";

describe("deployArgsGuardProblems", () => {
  it("✅ 通る例: target が delivery/admin で、追加引数が無い", () => {
    expect(deployArgsGuardProblems({ target: "delivery", extraArgs: [] })).toEqual([]);
    expect(deployArgsGuardProblems({ target: "admin", extraArgs: [] })).toEqual([]);
  });

  it("🔴 落ちる例: --route を渡した(wrangler.*.jsonc の routes を CLI から上書きできる)", () => {
    const problems = deployArgsGuardProblems({ target: "delivery", extraArgs: ["--route", "*.kyoukaisou.dev/*"] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("追加の引数を渡せない");
  });

  it("🔴 落ちる例: --domain を渡した(Custom Domain を追加できる)", () => {
    expect(
      deployArgsGuardProblems({ target: "admin", extraArgs: ["--domain", "evil.kyoukaisou.dev"] }).length,
    ).toBeGreaterThan(0);
  });

  it("🔴 落ちる例: 一見無害な引数(--dry-run 等)でも、追加の引数は一切許さない", () => {
    expect(deployArgsGuardProblems({ target: "delivery", extraArgs: ["--dry-run"] }).length).toBeGreaterThan(0);
  });

  it("🔴 落ちる例: target が未知の値", () => {
    const problems = deployArgsGuardProblems({ target: "production", extraArgs: [] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("使い方");
  });

  it("KNOWN_TARGETS は delivery と admin の2つだけ", () => {
    expect(KNOWN_TARGETS).toEqual(["delivery", "admin"]);
  });
});
