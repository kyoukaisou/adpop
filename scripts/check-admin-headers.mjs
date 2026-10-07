#!/usr/bin/env node
/*
  `out/_headers` に CSP が無いまま deploy しようとしていないか、
  `NEXT_PUBLIC_DELIVERY_ORIGIN` が `deploy/delivery-origin.txt` の確定値と完全一致しているかを見る。
  違反があれば非ゼロで終わる。判定は `scripts/admin-headers-guard.mjs`(CSP の形)と
  `scripts/delivery-origin-guard.mjs`(配信元の確定値との一致)の2本だけが持つ
  (テストで「落ちる例」と「通る例」の両方を固定してある)。

  🔴 **省略する経路は無い。** `wrangler.admin.jsonc` の `build.command` から呼ぶ(deploy の直前に
  必ず走る)。`deploy/delivery-origin.txt` が `UNSET`(未確定)のままなら必ず非ゼロで終わる
  (レビュー指摘: 前巡の `CI_DRY_RUN` フラグは、このフラグを立てたまま `wrangler deploy` を
  直接実行すれば本番でも検査を回避できてしまう欠陥だったため削除した)。
  CI は、このファイルを書き換える代わりに、実行するジョブのワークスペースの中だけで
  `deploy/delivery-origin.txt` と `NEXT_PUBLIC_DELIVERY_ORIGIN` に CI 専用の値(コミットしない)を
  一時的に入れてから、この検査を**通常の経路のまま**通す(`.github/workflows/ci.yml` 参照)。

  手元で確かめるときは:
  NEXT_PUBLIC_DELIVERY_ORIGIN=$(cat deploy/delivery-origin.txt) npm run build \
    && node scripts/check-admin-headers.mjs
*/
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryOriginEmbeddedProblems, headersGuardProblems } from "./admin-headers-guard.mjs";
import { deliveryOriginGuardProblems, readExpectedDeliveryOrigin } from "./delivery-origin-guard.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "out");
const HEADERS_PATH = path.join(OUT_DIR, "_headers");
const NEXT_DIR = path.join(OUT_DIR, "_next");

let headersContent;
try {
  headersContent = readFileSync(HEADERS_PATH, "utf8");
} catch {
  console.error(`NG  ${HEADERS_PATH} が無い(先に npm run build を実行してください)`);
  process.exit(1);
}

const deliveryOrigin = (process.env.NEXT_PUBLIC_DELIVERY_ORIGIN ?? "").replace(/\/$/, "");
const expectedOrigin = readExpectedDeliveryOrigin();

/** `dir` 以下の `.js` ファイルの中身を全部集める(ビルドのチャンク名はハッシュ付きで固定できないため)。 */
function collectJsContents(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  let contents = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) contents = contents.concat(collectJsContents(full));
    else if (entry.name.endsWith(".js")) contents.push(readFileSync(full, "utf8"));
  }
  return contents;
}

const problems = [
  ...headersGuardProblems({ headersContent, deliveryOrigin }),
  ...deliveryOriginEmbeddedProblems({ deliveryOrigin, fileContents: collectJsContents(NEXT_DIR) }),
  ...deliveryOriginGuardProblems({ actualOrigin: deliveryOrigin, expectedOrigin }),
];

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`NG  ${problem}`);
  }
  console.error(`\n${HEADERS_PATH} / out/_next は、確定した配信元を含めて正しくビルドされた形になっていません。`);
  console.error(`deploy/delivery-origin.txt の値を NEXT_PUBLIC_DELIVERY_ORIGIN に渡して npm run build をやり直してください。`);
  process.exit(1);
}

console.log(`OK  ${HEADERS_PATH} に CSP・X-Content-Type-Options・X-Frame-Options・Referrer-Policy があり、`);
console.log(`OK  配信元(${deliveryOrigin})が img-src とビルド出力の両方に入っている。`);
