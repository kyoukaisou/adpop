/*
  **`packages/embed/`(MIT)が、その外(AGPL-3.0)を1行も読まないこと**を判定するモジュール。
  副作用なし(読み込んでも何も実行しない)。

  🔴 なぜ機械で見るか(要件書 §5-6):
    **AGPL-3.0 と MIT は互換ではない。** 混ざると後から分離できない。
    「気をつける」では守れないので、**依存の向き(embed → server)を禁止**して毎 PR 測る。
  🔴 同時に、**依存ライブラリを1つも入れない**(要件書 §5-1)も同じ検査で見る ——
    外部パッケージを1つ入れた瞬間に gzip の上限を超えるため。

  ══════════════════════════════════════════════════════════════════════
  🔴🔴 **正規表現で import を数えるのをやめた**(2026-09-08 / Codex 1巡目 Medium・両モデル)
  ══════════════════════════════════════════════════════════════════════
  最初の版はソースを正規表現で走査していた。**2つの独立した抜け方が実在した**:
    ・`import{metadata}from"…"`(**空白が1つも無い書き方**)が、こちらの正規表現に当たらない
    ・集める対象の拡張子に **`.jsx` / `.mts` / `.cts` / `.cjs`** が無く、
      `loader.ts → ./bridge.jsx → ../../../src/…` が**緑のまま通る**
  📌 これは「ソース走査は『そう書いた形跡』を測り、『いま何を読んでいるか』を測らない」型そのもの。
  ✅ **esbuild の metafile(実際に解決された依存グラフ)で判定する。**
    バンドラが解決した結果なので、**書き方・拡張子・別名の違いを1つも取りこぼさない。**
*/

/** 判定の対象にするディレクトリ(リポジトリのルートからの相対)。 */
export const EMBED_ROOT = "packages/embed/";

/**
 * esbuild の metafile から、**MIT の外へ出ている入力**を挙げる。
 *
 * @param {{ inputs: Record<string, unknown> }} metafile
 * @param {{ root?: string }} options
 * @returns {Array<{ input: string, reason: string }>} 空配列 = 違反なし
 */
export function metafileViolations(metafile, options = {}) {
  const root = options.root ?? EMBED_ROOT;
  const inputs = Object.keys(metafile?.inputs ?? {});
  const violations = [];
  for (const input of inputs) {
    // esbuild は node_modules の入力を `node_modules/…` の形で並べる
    if (input.includes("node_modules/")) {
      violations.push({ input, reason: "外部パッケージを読んでいる(埋め込みスクリプトは依存ゼロ)" });
      continue;
    }
    if (!input.startsWith(root)) {
      violations.push({ input, reason: `${root} の外(= AGPL-3.0 側)を読んでいる` });
    }
  }
  return violations;
}

/**
 * 🔴 **「違反0件」を、測っていないことと取り違えない。**
 *   入口が消えた・metafile が空、を合格にしない。
 *
 * @returns {string[]} 空配列 = 測れている
 */
export function measurementProblems(metafile, entry) {
  const inputs = Object.keys(metafile?.inputs ?? {});
  const problems = [];
  if (inputs.length === 0) problems.push("metafile に入力が1件も無い(何も測っていない)");
  else if (!inputs.includes(entry)) problems.push(`入口 ${entry} が metafile の入力に無い`);
  return problems;
}
