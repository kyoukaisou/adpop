import { describe, expect, it } from "vitest";
import { toggleInSet } from "./toggleSet";

describe("toggleInSet", () => {
  it("include=true で無い値を足す", () => {
    const result = toggleInSet(new Set(["a"]), "b", true);
    expect([...result].sort()).toEqual(["a", "b"]);
  });

  it("include=false である値を外す", () => {
    const result = toggleInSet(new Set(["a", "b"]), "a", false);
    expect([...result]).toEqual(["b"]);
  });

  it("🔴 既に同じ状態なら同じ参照を返す(無駄な再レンダーを避ける)", () => {
    const set = new Set(["a"]);
    expect(toggleInSet(set, "a", true)).toBe(set);
    expect(toggleInSet(set, "b", false)).toBe(set);
  });

  it("状態が変わるときは新しい参照を返す(元のSetを書き換えない)", () => {
    const set = new Set(["a"]);
    const result = toggleInSet(set, "b", true);
    expect(result).not.toBe(set);
    expect(set.has("b")).toBe(false);
  });
});
