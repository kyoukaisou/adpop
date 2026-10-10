import { describe, expect, it } from "vitest";
import { chartHasData, niceMax, niceTicks } from "./dailyChart";
import type { DailyStatsPoint } from "./stats";

function point(p: Partial<DailyStatsPoint> & { date: string }): DailyStatsPoint {
  return { impression: 0, click: 0, close: 0, ...p };
}

describe("chartHasData(D-384 Codexレビュー指摘3)", () => {
  it("🔴 close だけが0件以上あっても「データなし」のまま(このグラフは close を描かない)", () => {
    const points = [point({ date: "2026-10-01", close: 5 }), point({ date: "2026-10-02", close: 2 })];
    expect(chartHasData(points)).toBe(false);
  });

  it("✅ impression が1件でもあれば「データあり」", () => {
    expect(chartHasData([point({ date: "2026-10-01", impression: 1 })])).toBe(true);
  });

  it("✅ click が1件でもあれば「データあり」", () => {
    expect(chartHasData([point({ date: "2026-10-01", click: 1 })])).toBe(true);
  });

  it("全日0なら「データなし」", () => {
    expect(chartHasData([point({ date: "2026-10-01" }), point({ date: "2026-10-02" })])).toBe(false);
  });

  it("空配列も「データなし」", () => {
    expect(chartHasData([])).toBe(false);
  });
});

describe("niceMax", () => {
  it("0以下は既定の4", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(-5)).toBe(4);
  });
  it("187 → 200・42 → 50(見本どおりの丸め)", () => {
    expect(niceMax(187)).toBe(200);
    expect(niceMax(42)).toBe(50);
  });
});

describe("niceTicks(D-384 Codexレビュー指摘3: 小さい最大値での重複)", () => {
  it("🔴 max=1・count=4 でも目盛りが重複しない(以前は [0,0,1,1,1] になっていた)", () => {
    const ticks = niceTicks(1, 4);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("🔴 max=2・max=3 でも重複しない", () => {
    expect(new Set(niceTicks(2, 4)).size).toBe(niceTicks(2, 4).length);
    expect(new Set(niceTicks(3, 4)).size).toBe(niceTicks(3, 4).length);
  });

  it("昇順(グラフの上から下への並びと矛盾しない)。1〜500の全整数で確かめる", () => {
    for (let max = 1; max <= 500; max++) {
      const ticks = niceTicks(max, 4);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i], `max=${max}: ${JSON.stringify(ticks)}`).toBeGreaterThan(ticks[i - 1]);
      }
    }
  });

  it("max=200・count=4 → [0,50,100,150,200](きりのいい値は等分割のまま)", () => {
    expect(niceTicks(200, 4)).toEqual([0, 50, 100, 150, 200]);
  });

  it("max=0以下は [0] のみ", () => {
    expect(niceTicks(0, 4)).toEqual([0]);
  });
});
