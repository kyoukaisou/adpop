/*
  `packages/embed/` の中のソースを集めるだけのモジュール(副作用なし)。
  ライセンス境界の**第2段**(到達していないファイルも読む)が使う。

  ⚠ 集め方をここ1本に置く。2か所に書くと、片方だけ直した日に「集めているものが違う」状態になる。
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const EMBED_DIR = "packages/embed";

/**
 * TS / JS 系の拡張子。
 * 🔴 **`.jsx` / `.mts` / `.cts` / `.cjs` を落としていたのが穴だった**(Codex 1巡目)。
 *   `loader.ts → ./bridge.jsx → ../../../src/…` が、集める対象の外なので緑のまま通った。
 */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** @returns {Array<{ path: string, source: string }>} path はリポジトリのルートからの相対(POSIX 区切り) */
export function collectEmbedFiles(repoRoot) {
  const base = path.join(repoRoot, EMBED_DIR);
  const files = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute)) {
      // dist はビルドの出力(バンドル後は import が畳まれている)、node_modules は他人のコード
      if (entry === "node_modules" || entry === "dist") continue;
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!SOURCE_EXTENSIONS.includes(path.extname(entry))) continue;
      files.push({
        path: path.relative(repoRoot, child).split(path.sep).join("/"),
        source: readFileSync(child, "utf8"),
      });
    }
  };
  walk(base);
  return files;
}
