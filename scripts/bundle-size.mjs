/*
  埋め込みスクリプトの重さの上限(要件書 §5-1)。**判定だけを持つモジュール**(副作用なし)。

  🔴 上限の数字はここ1か所だけが持つ。README にも CI にも書き写さない
    (写した側が古くなっても誰も落ちない)。
  ⚠ **この上限値に外部根拠は無い**(要件書 §5-1: 本部が置いた設計目標)。
    「軽い」と主張するのではなく、**CI が測った値をそのまま出す**。
*/
import { gzipSync } from "node:zlib";

/** 1KB = 1024 バイトで数える。 */
export const KB = 1024;

export const BUNDLES = [
  {
    id: "loader",
    entry: "packages/embed/src/loader.ts",
    out: "packages/embed/dist/t.js",
    label: "ローダ t.js(全訪問者に配る)",
    gzipLimit: 5 * KB,
  },
  {
    id: "runtime",
    entry: "packages/embed/src/runtime.ts",
    out: "packages/embed/dist/adpop.js",
    label: "本体(発火してから取りに行く)",
    gzipLimit: 20 * KB,
  },
];

/** 合計(発火した訪問者の総量。画像を除く)。 */
export const TOTAL_GZIP_LIMIT = 25 * KB;

export function gzipSizeOf(source) {
  return gzipSync(Buffer.from(source, "utf8"), { level: 9 }).length;
}

/**
 * 測った値を上限と突き合わせる。**この関数だけが合否を決める。**
 * @param {Record<string, number>} measured 例 `{ loader: 1234, runtime: 5678 }`
 * @returns {{
 *   ok: boolean,
 *   rows: Array<{ id: string, label: string, bytes: number, limit: number, ok: boolean }>,
 *   total: { bytes: number, limit: number, ok: boolean },
 *   missing: string[]
 * }}
 */
export function evaluateSizes(measured, bundles = BUNDLES, totalLimit = TOTAL_GZIP_LIMIT) {
  const missing = bundles.filter((b) => typeof measured[b.id] !== "number").map((b) => b.id);
  const rows = bundles
    .filter((b) => typeof measured[b.id] === "number")
    .map((b) => ({
      id: b.id,
      label: b.label,
      bytes: measured[b.id],
      limit: b.gzipLimit,
      ok: measured[b.id] <= b.gzipLimit,
    }));
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const total = { bytes: totalBytes, limit: totalLimit, ok: totalBytes <= totalLimit };
  /*
    🔴 **測れなかったものは「合格」にしない。**
      入口が消えたりビルドが空を吐いたときに、上限検査が黙って緑になるのを避ける
      (= 検査が何も守っていない状態)。
  */
  return { ok: missing.length === 0 && total.ok && rows.every((row) => row.ok), rows, total, missing };
}

export function formatReport(result) {
  const line = (name, bytes, limit, ok) =>
    `  ${ok ? "OK  " : "NG  "} ${name}: ${bytes} B (gzip) / 上限 ${limit} B`;
  const lines = result.rows.map((row) => line(row.label, row.bytes, row.limit, row.ok));
  lines.push(line("合計", result.total.bytes, result.total.limit, result.total.ok));
  for (const id of result.missing) lines.push(`  NG   ${id}: 測れなかった(ビルドの出力が無い)`);
  return lines.join("\n");
}
