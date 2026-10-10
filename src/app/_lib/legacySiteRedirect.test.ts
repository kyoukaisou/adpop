import { describe, expect, it } from "vitest";
import { legacySiteRedirectTarget } from "./legacySiteRedirect";

describe("legacySiteRedirectTarget(旧 /site?id=... の互換転送。D-384 Codexレビュー指摘2)", () => {
  it("🔴 id があれば /popups?site=<id> へ(クエリ名を id→site に積み替える)", () => {
    expect(legacySiteRedirectTarget("abc-123")).toBe("/popups?site=abc-123");
  });

  it("⚠ id が無い(空)なら /sites へ(行き先が決められないので一覧に倒す)", () => {
    expect(legacySiteRedirectTarget("")).toBe("/sites");
  });
});
