import { describe, expect, it } from "vitest";
import { deleteConfirmStatsText, formatStatCount, type ApiPopupStatsMap } from "./stats";

const MAP: ApiPopupStatsMap = {
  p1: {
    sevenDay: { impression: 1204, click: 58, close: 812 },
    lifetime: { impression: 4820, click: 201, close: 3300 },
  },
  p2: {
    sevenDay: { impression: 0, click: 0, close: 0 },
    lifetime: { impression: 0, click: 0, close: 0 },
  },
};

describe("formatStatCount", () => {
  it("🔴 stats が null(取得そのものが失敗)なら「—」(0 と見分けがつく)", () => {
    expect(formatStatCount(null, "p1", "sevenDay", "impression")).toBe("—");
  });

  it("🔴 そのポップの行が無ければ「—」(0件と誤読させない)", () => {
    expect(formatStatCount(MAP, "missing", "sevenDay", "impression")).toBe("—");
  });

  it("✅ 0件のポップは「—」ではなく \"0\"(取得できた0件と取得失敗は別)", () => {
    expect(formatStatCount(MAP, "p2", "sevenDay", "click")).toBe("0");
  });

  it("3桁区切りで出す(見本 03-popups-1280.png の 1,204 の形)", () => {
    expect(formatStatCount(MAP, "p1", "sevenDay", "impression")).toBe("1,204");
    expect(formatStatCount(MAP, "p1", "lifetime", "impression")).toBe("4,820");
  });

  it("period/kind を取り違えない(sevenDay と lifetime、3種類とも別の値を返す)", () => {
    expect(formatStatCount(MAP, "p1", "sevenDay", "click")).toBe("58");
    expect(formatStatCount(MAP, "p1", "lifetime", "click")).toBe("201");
    expect(formatStatCount(MAP, "p1", "sevenDay", "close")).toBe("812");
    expect(formatStatCount(MAP, "p1", "lifetime", "close")).toBe("3,300");
  });
});

describe("deleteConfirmStatsText", () => {
  it("🔴 stats が null なら null(ダイアログは一般文にフォールバックする)", () => {
    expect(deleteConfirmStatsText(null, "p1")).toBeNull();
  });

  it("🔴 そのポップの行が無ければ null", () => {
    expect(deleteConfirmStatsText(MAP, "missing")).toBeNull();
  });

  it("✅ 見本(03d-popups-delete-confirm-1280.png)の文言どおり「表示 N・クリック N・閉じた N」(累計)", () => {
    expect(deleteConfirmStatsText(MAP, "p1")).toBe("表示 4,820・クリック 201・閉じた 3,300");
  });

  it("0件でも null にならない(取得できた0は出す)", () => {
    expect(deleteConfirmStatsText(MAP, "p2")).toBe("表示 0・クリック 0・閉じた 0");
  });
});
