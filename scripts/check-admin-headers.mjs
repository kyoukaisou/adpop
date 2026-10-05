#!/usr/bin/env node
/*
  `out/_headers` に CSP が無いまま deploy しようとしていないか、
  `NEXT_PUBLIC_DELIVERY_ORIGIN` が `deploy/delivery-origin.txt` の確定値と完全一致しているかを見る。
  違反があれば非ゼロで終わる。判定は `scripts/admin-headers-guard.mjs`(CSP の形)と
  `scripts/delivery-origin-guard.mjs`(配信元の確定値との一致)の2本だけが持つ
  (テストで「落ちる例」と「通る例」の両方を固定してある)。

  `wrangler.admin.jsonc` の `build.command` から呼ぶ(deploy の直前に必ず走る)。
  手元で確かめるときは:
  NEXT_PUBLIC_DELIVERY_ORIGIN=$(cat deploy/delivery-origin.txt) npm run build \
    && node scripts/check-admin-headers.mjs

  ⚠ `CI_DRY_RUN=1` のときだけ、`deploy/delivery-origin.txt` が未確定(`UNSET`)でも
  「配信元が確定値と一致しているか」の検査だけを省略する(CSP の形・ビルド出力への埋め込みの
  検査は省略しない)。CI はバンドルが壊れていないかを見るためのものであり、まだ実在しない
  本番の origin とは比べられないため。この変数は `.github/workflows/ci.yml` の dry-run ステップ
  以外では設定しない(本番の deploy では絶対に渡さないこと)。
*/
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryOriginEmbeddedProblems, headersGuardProblems } from "./admin-headers-guard.mjs";
import { deliveryOriginGuardProblems, readExpectedDeliveryOrigin, UNSET_DELIVERY_ORIGIN } from "./delivery-origin-guard.mjs";

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
const ciDryRun = process.env.CI_DRY_RUN === "1";

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
];

const skipConfirmationCheck = ciDryRun && expectedOrigin.trim() === UNSET_DELIVERY_ORIGIN;
if (skipConfirmationCheck) {
  console.log(
    `OK  (CI_DRY_RUN=1) deploy/delivery-origin.txt が ${UNSET_DELIVERY_ORIGIN} のため、配信元の確定チェックは省略する。`,
  );
} else {
  problems.push(...deliveryOriginGuardProblems({ actualOrigin: deliveryOrigin, expectedOrigin }));
}

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
