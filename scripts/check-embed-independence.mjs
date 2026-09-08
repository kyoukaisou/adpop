#!/usr/bin/env node
/*
  `packages/embed/`(MIT)が AGPL 側を読んでいないことを、**esbuild が実際に解決した依存グラフ**で見る。
  違反があれば非ゼロで終わる。判定は `scripts/embed-independence.mjs` の1本だけが持つ
  (テストで「落ちる例」と「通る例」の両方を固定してある)。
*/
import ts from "typescript";
import { BUNDLES } from "./bundle-size.mjs";
import { buildEmbedBundle, REPO_ROOT } from "./embed-build.mjs";
import { collectEmbedFiles } from "./embed-files.mjs";
import {
  EMBED_ROOT,
  fileScanProblems,
  measurementProblems,
  metafileViolations,
  staticImportViolations,
} from "./embed-independence.mjs";

let failed = false;

// ── 第1段: 入口から実際に解決された依存グラフ(バンドラの結果) ──────────
for (const bundle of BUNDLES) {
  const { metafile } = await buildEmbedBundle(bundle, { metafile: true });

  const problems = measurementProblems(metafile, bundle.entry);
  for (const problem of problems) {
    console.error(`NG  ${bundle.entry}: ${problem}`);
    failed = true;
  }

  const violations = metafileViolations(metafile);
  for (const violation of violations) {
    console.error(`NG  ${bundle.entry} → ${violation.input}: ${violation.reason}`);
    failed = true;
  }

  if (problems.length === 0 && violations.length === 0) {
    const count = Object.keys(metafile.inputs).length;
    console.log(`OK  ${bundle.entry}: 解決された入力 ${count} 件、すべて ${EMBED_ROOT} の中。`);
  }
}

// ── 第2段: **到達していないファイル**と **`import type`**(metafile に出ないもの)──────
const files = collectEmbedFiles(REPO_ROOT);
for (const problem of fileScanProblems(files)) {
  console.error(`NG  ${problem}`);
  failed = true;
}
const staticViolations = staticImportViolations(files, { ts });
for (const violation of staticViolations) {
  console.error(`NG  ${violation.file} → "${violation.specifier}": ${violation.reason}`);
  failed = true;
}
if (staticViolations.length === 0 && files.length > 0) {
  console.log(`OK  ${files.length} ファイルの静的 import を全部読んだ(到達していないファイルと import type も含む)。`);
}

if (failed) {
  console.error(
    `\n${EMBED_ROOT} は MIT、リポジトリの他は AGPL-3.0(LICENSING.md)。依存の向きは embed → server を禁止しています。`,
  );
  process.exit(1);
}
