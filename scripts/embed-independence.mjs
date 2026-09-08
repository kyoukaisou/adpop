/*
  **`packages/embed/`(MIT)が、その外(AGPL-3.0)を1行も読まないこと**を判定するモジュール。
  副作用なし(読み込んでも何も実行しない)。

  🔴 なぜ機械で見るか(要件書 §5-6):
    **AGPL-3.0 と MIT は互換ではない。** 混ざると後から分離できない。
    「気をつける」では守れないので、**依存の向き(embed → server)を禁止**して毎 PR 測る。
  🔴 同時に、**依存ライブラリを1つも入れない**(要件書 §5-1)も同じ検査で見る ——
    外部パッケージを1つ入れた瞬間に gzip の上限を超えるため。
*/

/** import / export from / dynamic import / require の指定子を全部拾う。 */
export function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}(=])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;}(=])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // 副作用だけの import(`import "…";`)
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * 許すのは「`packages/embed/` の中で閉じた相対 import」だけ。
 * ⚠ **禁止の一覧を数え上げない**(数え落とすため)。**通してよい形を1つ指す**
 *   ([[SaaS開発ナレッジ]] 2026-09-08-15 の裏返しの型)。
 *
 * @param {string} specifier import の指定子
 * @param {string} fileDir  そのファイルの、`packages/embed/` から見た相対ディレクトリ("" か "sub" など)
 */
export function violationOf(specifier, fileDir) {
  if (!specifier.startsWith(".")) {
    // 素の名前 = 外部パッケージ / Node の組み込み / `@/` 別名
    return specifier.startsWith("@/")
      ? "AGPL 側(src/)を別名 @/ で読んでいる"
      : "外部パッケージまたは組み込みモジュールを読んでいる(埋め込みスクリプトは依存ゼロ)";
  }
  const segments = [...fileDir.split("/").filter(Boolean), ...specifier.split("/")];
  const resolved = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (resolved.length === 0) return "packages/embed/ の外(= AGPL 側)を読んでいる";
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return null;
}

/**
 * @param {Array<{ path: string, dir: string, source: string }>} files
 *   `path` は表示用、`dir` は `packages/embed/` から見た相対ディレクトリ。
 * @returns {Array<{ file: string, specifier: string, reason: string }>} 空配列 = 違反なし
 */
export function findViolations(files) {
  const violations = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file.source)) {
      const reason = violationOf(specifier, file.dir);
      if (reason) violations.push({ file: file.path, specifier, reason });
    }
  }
  return violations;
}
