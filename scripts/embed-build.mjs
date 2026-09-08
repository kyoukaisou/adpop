/*
  `packages/embed/` を esbuild で束ねるところだけを持つモジュール。
  **サイズ検査(scripts/check-bundle-size.mjs)とライセンス境界の検査
  (scripts/check-embed-independence.mjs)の両方が、同じ1本の束ね方を使う。**
  ⚠ 別々に書くと、片方だけ設定が変わった日に「測っているものが違う」状態になる。
*/
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {{ entry: string }} bundle 例 `{ entry: "packages/embed/src/loader.ts" }`
 * @param {{ metafile?: boolean }} options
 */
export async function buildEmbedBundle(bundle, options = {}) {
  const result = await build({
    entryPoints: [bundle.entry],
    bundle: true,
    minify: true,
    format: "iife",
    // ⚠ 埋め込み先のブラウザで動く。古い端末を落とさない範囲に寄せる。
    target: ["es2019"],
    write: false,
    metafile: options.metafile === true,
    logLevel: "silent",
    // 🔴 `metafile.inputs` の鍵はここからの相対パスになる。リポジトリのルートに固定する。
    absWorkingDir: REPO_ROOT,
  });
  return { code: result.outputFiles[0].text, metafile: result.metafile };
}
