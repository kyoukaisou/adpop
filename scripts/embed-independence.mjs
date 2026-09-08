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

/*
  ══════════════════════════════════════════════════════════════════════
  第2段: **到達していないファイル**と **`import type`** を見る(Codex 2巡目 Medium)
  ══════════════════════════════════════════════════════════════════════
  🔴 **metafile だけでは足りない理由**(2つとも「metafile に出ない」):
    ・**入口から到達していないファイル**(まだどこからも import されていない書きかけ)
    ・**`import type { X } from "…"`** —— 型だけの import は**バンドル後に消える**ので、
      esbuild の依存グラフに現れない。**しかし AGPL 側のコードを参照していることに変わりはない。**
  ✅ `typescript` の `ts.preProcessFile` で **静的な import 指定子を全部拾う**。
    ⚠ 正規表現は書かない(空白の有無・拡張子・書き方で漏れたのが1巡目の欠陥)。
  ⚠ **限界(そのまま README / LICENSING.md に書く)**:
    **文字列を実行時に組み立てる `import(variable)` は見ない。** 静的に書かれた指定子だけ。
*/

/** POSIX の相対パス解決。`..` がルートを飛び出したら null を返す。 */
function resolveRelative(fromDir, specifier) {
  const segments = [...fromDir.split("/").filter(Boolean), ...specifier.split("/")];
  const stack = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

/**
 * @param {Array<{ path: string, source: string }>} files リポジトリのルートからの相対パスと中身
 * @param {{ ts: typeof import("typescript"), root?: string }} deps
 *   ⚠ `typescript` は呼ぶ側から渡す(このモジュールを副作用なしに保つため)
 * @returns {Array<{ file: string, specifier: string, reason: string }>}
 */
export function staticImportViolations(files, deps) {
  const root = deps.root ?? EMBED_ROOT;
  const ts = deps.ts;
  const violations = [];
  for (const file of files) {
    const info = ts.preProcessFile(file.source, true, true);
    const specifiers = [
      ...info.importedFiles.map((f) => f.fileName),
      // triple-slash の `/// <reference path="…" />` も経路になる
      ...info.referencedFiles.map((f) => f.fileName),
      ...info.typeReferenceDirectives.map((f) => f.fileName),
    ];
    const dir = file.path.split("/").slice(0, -1).join("/");
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        violations.push({
          file: file.path,
          specifier,
          reason: specifier.startsWith("@/")
            ? "AGPL 側(src/)を別名 @/ で参照している"
            : "外部パッケージ・組み込みモジュールを参照している(埋め込みスクリプトは依存ゼロ)",
        });
        continue;
      }
      const resolved = resolveRelative(dir, specifier);
      if (resolved === null || !resolved.startsWith(root)) {
        violations.push({
          file: file.path,
          specifier,
          reason: `${root} の外(= AGPL-3.0 側)を参照している`,
        });
      }
    }
  }
  return violations;
}

/** 🔴 0件を「違反なし」と読ませない(集める対象が消えたら、それは測れていない)。 */
export function fileScanProblems(files) {
  return files.length === 0 ? [`${EMBED_ROOT} に検査対象のソースが1つも無い(何も測っていない)`] : [];
}
