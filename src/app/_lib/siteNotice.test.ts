import { describe, expect, it } from "vitest";
import { shouldShowNoActivePopupNotice } from "./siteNotice";
import { ApiPopup } from "./types";

function popup(status: ApiPopup["status"], archivedAt: string | null = null): ApiPopup {
  return {
    id: `p-${status}-${archivedAt ?? "active"}`,
    siteId: "site-1",
    name: "ポップ",
    status,
    archivedAt,
    suppressDays: 0,
    sessionImpressions: 1,
    postConversionDays: 0,
    minDisplayDelaySeconds: 0,
  };
}

describe("shouldShowNoActivePopupNotice", () => {
  it("0件(ポップが1件も無い) → 出さない(EmptyState に任せる)", () => {
    expect(shouldShowNoActivePopupNotice([], false)).toBe(false);
  });

  it("読み込み中(popups === null) → 出さない(無いと確認できていない)", () => {
    expect(shouldShowNoActivePopupNotice(null, false)).toBe(false);
  });

  it("最初の失敗(popups === null のまま) → 出さない", () => {
    // 初回読み込み失敗は loadError になり popups は null のまま(site/page.tsx の load() 参照)。
    // 「読み込み中」と状態としては同じ(popups === null)なので、ここで固定する。
    expect(shouldShowNoActivePopupNotice(null, false)).toBe(false);
  });

  it("再取得の失敗(reloadError) → popups が稼働0件のデータでも出さない(古いデータの可能性があるため)", () => {
    const popups = [popup("paused")];
    expect(shouldShowNoActivePopupNotice(popups, true)).toBe(false);
    // 🔴 壊したら落ちることの確認: reloadError を無視する実装だと、ここは true になってしまう
    expect(popups.some((p) => p.status === "active")).toBe(false);
  });

  it("アーカイブ済みだけ(非アーカイブは0件) → 出さない(下の EmptyState に任せる。帯の二重表示を避ける)", () => {
    // 🔴 サーバーは archive 時に status を active→paused へ強制する(src/lib/data/admin.ts)ため
    //   実運用で archivedAt あり・status active は起きないが、念のため両方のケースを固定する。
    const popups = [popup("paused", "2026-10-01T00:00:00.000Z")];
    expect(shouldShowNoActivePopupNotice(popups, false)).toBe(false);
  });

  it("稼働中のポップがアーカイブ済みだけ(非アーカイブは0件) → 出さない", () => {
    const popups = [popup("active", "2026-10-01T00:00:00.000Z")];
    expect(shouldShowNoActivePopupNotice(popups, false)).toBe(false);
  });

  it("稼働中が1件でもあれば出さない", () => {
    const popups = [popup("paused"), popup("active")];
    expect(shouldShowNoActivePopupNotice(popups, false)).toBe(false);
  });

  it("非アーカイブは稼働0件だが、アーカイブ済みに稼働中が混ざっている → 出す(アーカイブ済みは数えない)", () => {
    const popups = [popup("paused"), popup("active", "2026-10-01T00:00:00.000Z")];
    expect(shouldShowNoActivePopupNotice(popups, false)).toBe(true);
  });

  it("壊れた判定(reloadError を見ない実装)だと、再取得失敗のケースが期待と変わることを確認する", () => {
    // 🔴 レビュー指摘の裁定「壊したら落ちることを1回確かめる」に対応する検査。
    function brokenShouldShow(popups: ApiPopup[] | null): boolean {
      if (popups === null) return false;
      if (popups.length === 0) return false;
      return !popups.some((p) => p.status === "active");
    }
    const popups = [popup("paused")];
    expect(brokenShouldShow(popups)).not.toEqual(shouldShowNoActivePopupNotice(popups, true));
  });
});
