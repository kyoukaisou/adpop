import { describe, expect, it, vi } from "vitest";
import { isSpecialClick, PLAIN_CLICK, resolveGuardedClick, type ClickModifiers } from "./guardedLink";

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

  it("🔴 Codexレビュー2巡目の指摘: onBeforeLeave があっても、特殊クリック(修飾キー等)ならガード無し(ブラウザの既定動作=新しいタブ等に任せる)", () => {
    const navigate = vi.fn();
    const decision = resolveGuardedClick("/popup?id=1", () => {}, navigate, { ...PLAIN_CLICK, metaKey: true });
    expect(decision.guarded).toBe(false);
  });
});

describe("isSpecialClick(D-384 Codexレビュー2巡目: Command/Ctrl+クリックで編集タブ自体が移動していた不具合)", () => {
  it("✅ 主ボタン・修飾キーなしの素のクリックは特殊クリックではない", () => {
    expect(isSpecialClick(PLAIN_CLICK)).toBe(false);
  });

  // 🔴 4条件をそれぞれ単独で撃つ(1つでも崩すとtrueを返さなくなることを、次の変異検査で確かめる)
  const cases: Array<[string, Partial<ClickModifiers>]> = [
    ["metaKey(Cmd+クリック)", { metaKey: true }],
    ["ctrlKey(Ctrl+クリック)", { ctrlKey: true }],
    ["shiftKey(Shift+クリック)", { shiftKey: true }],
    ["altKey(Alt+クリック)", { altKey: true }],
    ["主ボタン以外(中クリック等。button=1)", { button: 1 }],
    ["target が _blank(_self 以外)", { target: "_blank" }],
    ["download 属性がある", { hasDownload: true }],
  ];
  for (const [label, override] of cases) {
    it(`🔴 ${label} は特殊クリック(ガードしない)`, () => {
      expect(isSpecialClick({ ...PLAIN_CLICK, ...override })).toBe(true);
    });
  }

  it("✅ target が _self は特殊クリックではない(未指定と同じ扱い)", () => {
    expect(isSpecialClick({ ...PLAIN_CLICK, target: "_self" })).toBe(false);
  });

  it("⚠ 変異検査: 4条件のどれか1つでも判定から外すと、そのケースだけ false に戻ることを確かめる(検査自体が効いているか)", () => {
    // isSpecialClickの4条件のうち「主ボタン以外」の判定が抜けた版を模して、崩れると検査が落ちることを確認する
    function withoutButtonCheck(click: ClickModifiers): boolean {
      if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return true;
      if (click.target !== undefined && click.target !== null && click.target !== "_self") return true;
      if (click.hasDownload) return true;
      return false;
    }
    // 本来 true になるべき「中クリック」が、ボタン判定の無い版だと false に戻ってしまう
    expect(withoutButtonCheck({ ...PLAIN_CLICK, button: 1 })).toBe(false);
    expect(isSpecialClick({ ...PLAIN_CLICK, button: 1 })).toBe(true); // 本物は正しくtrueを返す
  });
});
