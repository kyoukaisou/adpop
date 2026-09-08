#!/usr/bin/env node
/*
  `packages/embed/`(MIT)が AGPL 側を読んでいないことを実ファイルで見る。違反があれば非ゼロで終わる。
  判定は `scripts/embed-independence.mjs` の1本だけが持つ(テストで両側を固定してある)。
*/
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectEmbedFiles, EMBED_ROOT } from "./embed-files.mjs";
import { findViolations } from "./embed-independence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = collectEmbedFiles(ROOT);

if (files.length === 0) {
  // 🔴 0件を「違反なし」と読ませない(入口が消えたら黙って緑になる)
  console.error(`${EMBED_ROOT} に .ts / .js が1つも見つかりません。検査が空回りしています。`);
  process.exit(1);
}

const violations = findViolations(files);
for (const violation of violations) {
  console.error(`NG  ${violation.file}: "${violation.specifier}" — ${violation.reason}`);
}

if (violations.length > 0) {
  console.error(
    `\n${EMBED_ROOT} は MIT、リポジトリの他は AGPL-3.0(LICENSING.md)。依存の向きは embed → server を禁止しています。`,
  );
  process.exit(1);
}

console.log(`OK  ${files.length} ファイルを検査。${EMBED_ROOT} は外を1つも読んでいません。`);
