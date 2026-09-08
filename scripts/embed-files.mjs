/*
  `packages/embed/` の中の .ts / .js を集めるだけのモジュール(副作用なし)。
  CLI とテストの両方から使う —— **集め方を2か所に書くと、片方だけ直した日にずれる。**
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const EMBED_ROOT = "packages/embed";

/** @returns {Array<{ path: string, dir: string, source: string }>} */
export function collectEmbedFiles(repoRoot) {
  const base = path.join(repoRoot, EMBED_ROOT);
  const files = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute)) {
      // dist はビルドの出力なので見ない(バンドル後は import が畳まれている)
      if (entry === "node_modules" || entry === "dist") continue;
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry)) continue;
      files.push({
        path: path.relative(repoRoot, child),
        dir: path.relative(base, path.dirname(child)).split(path.sep).join("/"),
        source: readFileSync(child, "utf8"),
      });
    }
  };
  walk(base);
  return files;
}
