// @vitest-environment node
//
// 埋め込みスクリプトの上限検査(要件書 §5-1)の**判定そのもの**を固定する。
//
// 🔴 PR1 では `packages/embed/` の中身が空なので、実測は必ず上限を下回る。
//   = **実測だけでは、この検査が働くかどうかが1つも分からない。**
//   → 判定関数を**両側**(超える / 超えない / 測れない)で撃つ。
import { describe, expect, it } from "vitest";
import { BUNDLES, KB, TOTAL_GZIP_LIMIT, evaluateSizes, gzipSizeOf } from "../scripts/bundle-size.mjs";

describe("上限の値は要件書 §5-1 のとおり", () => {
  it("ローダは gzip 5KB・本体は 20KB・合計は 25KB", () => {
    const limits = Object.fromEntries(BUNDLES.map((b) => [b.id, b.gzipLimit]));
    expect(limits).toEqual({ loader: 5 * KB, runtime: 20 * KB });
    expect(TOTAL_GZIP_LIMIT).toBe(25 * KB);
  });
});

describe("判定(evaluateSizes)", () => {
  it("上限より小さければ通る", () => {
    const result = evaluateSizes({ loader: 4 * KB, runtime: 19 * KB });
    expect(result.ok).toBe(true);
    expect(result.total.bytes).toBe(23 * KB);
  });

  it("🔴 ローダが1バイトでも上限を超えたら落ちる", () => {
    const result = evaluateSizes({ loader: 5 * KB + 1, runtime: 0 });
    expect(result.ok).toBe(false);
    expect(result.rows.find((row) => row.id === "loader")?.ok).toBe(false);
  });

  it("🔴 個別は上限内でも、合計が上限を超えたら落ちる", () => {
    // 5KB + 20KB = 25KB ちょうどは通る。1バイト足すと落ちる。
    expect(evaluateSizes({ loader: 5 * KB, runtime: 20 * KB }).ok).toBe(true);
    const over = evaluateSizes({ loader: 5 * KB, runtime: 20 * KB + 1 });
    expect(over.ok).toBe(false);
    expect(over.total.ok).toBe(false);
  });

  it("🔴 測れなかったものは合格にしない(入口が消えたら緑にならない)", () => {
    const result = evaluateSizes({ loader: 100 });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["runtime"]);
  });
});

describe("gzip の測り方", () => {
  it("同じ内容なら同じ大きさになり、繰り返しの多い文字列は縮む", () => {
    const repeated = "a".repeat(50_000);
    expect(gzipSizeOf(repeated)).toBe(gzipSizeOf(repeated));
    expect(gzipSizeOf(repeated)).toBeLessThan(repeated.length / 10);
  });
});
