#!/usr/bin/env node
/*
  `out/_headers` に CSP が無いまま deploy しようとしていないかを見る。違反があれば非ゼロで終わる。
  判定は `scripts/admin-headers-guard.mjs` の1本だけが持つ(テストで「落ちる例」と「通る例」の
  両方を固定してある)。

  `wrangler.admin.jsonc` の `build.command` から呼ぶ(deploy の直前に必ず走る)。
  手元で確かめるときは: `npm run build && node scripts/check-admin-headers.mjs`
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headersGuardProblems } from "./admin-headers-guard.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADERS_PATH = path.join(REPO_ROOT, "out", "_headers");

let content;
try {
  content = readFileSync(HEADERS_PATH, "utf8");
} catch {
  console.error(`NG  ${HEADERS_PATH} が無い(先に npm run build を実行してください)`);
  process.exit(1);
}

const problems = headersGuardProblems(content);
if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`NG  ${problem}`);
  }
  console.error(`\n${HEADERS_PATH} は CSP 無しで本番に出る形になっています。npm run build をやり直してください。`);
  process.exit(1);
}

console.log(`OK  ${HEADERS_PATH} に CSP・X-Content-Type-Options・X-Frame-Options がある。`);
