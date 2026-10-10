import { describe, expect, it, vi } from "vitest";
import { resolveGuardedClick } from "./guardedLink";

describe("resolveGuardedClick(D-384 Codexレビュー指摘4: サイドバー・ドロワー・サイト切替・パンくずの共通ガード)", () => {
  it("🔴 onBeforeLeave が無ければガード無し(素の<a>の既定のナビゲーションに任せる)", () => {
    const decision = resolveGuardedClick("/dashboard?site=1", undefined, vi.fn());
    expect(decision.guarded).toBe(false);
  });

  it("🔴 onBeforeLeave があればガード有り。proceed() を呼ぶと navigate(href) が実行され、true を返す", () => {
    const navigate = vi.fn();
    const decision = resolveGuardedClick("/popups?site=1", () => {}, navigate);
    expect(decision.guarded).toBe(true);
    if (!decision.guarded) throw new Error("unreachable");
    expect(decision.proceed()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/popups?site=1");
  });

  it("✅ onBeforeLeave 自体には proceed がそのまま渡る想定(呼び出し側が確認モーダルを経由して呼ぶ)", () => {
    const navigate = vi.fn();
    const onBeforeLeave = vi.fn();
    const decision = resolveGuardedClick("/tags?site=1", onBeforeLeave, navigate);
    if (!decision.guarded) throw new Error("unreachable");
    onBeforeLeave(decision.proceed);
    expect(onBeforeLeave).toHaveBeenCalledWith(decision.proceed);
    expect(navigate).not.toHaveBeenCalled(); // onBeforeLeave自身がまだproceedを呼んでいない(確認待ち)
  });
});
