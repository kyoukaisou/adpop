#!/usr/bin/env node
/*
  管理画面の `out/_headers` を、**ビルド後の実物の HTML から**作る。
  `npm run build`(= build:embed && next build && build:admin-headers)の最後に走る。

  🔴 `_headers` は Cloudflare の静的配信にしか効かない(`/api/*` は Worker のコードが先に走る。
    Hono 側のヘッダは src/admin/app.ts のミドルウェアが持つ。M8)。
  🔴 配信元(`NEXT_PUBLIC_DELIVERY_ORIGIN`)の値はそのまま信じない。ワイルドカード・非 https を
    含む値は img-src に入れない(fail-closed。設定ミスで CSP が緩むより、サムネイルが出ない方を選ぶ)。
*/
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCsp, collectScriptHashes } from "./csp.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ADMIN_OUT_DIR = path.join(REPO_ROOT, "out");

/** `https://host` または `https://host:port` の形だけを許す(ワイルドカード・パス・クエリは断る)。 */
export function isSafeOrigin(value) {
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value);
}

/**
 * `out/_headers` の中身を組み立てる(純粋関数。実際のファイル I/O は `main()` だけが持つ)。
 * `/*` の1ルールに全ヘッダをまとめる(管理画面はページ数が少なく、見込みの文字数は上限
 * 〈100 ルール・1行 2,000 文字〉に収まる。security 監査 M8)。
 */
export function buildAdminHeadersFile({ htmlContents, deliveryOrigin }) {
  const scriptHashes = collectScriptHashes(htmlContents);
  const origin = deliveryOrigin && isSafeOrigin(deliveryOrigin) ? deliveryOrigin : null;
  const csp = buildCsp({ scriptHashes, deliveryOrigin: origin });
  return [
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  X-Frame-Options: DENY",
    "",
  ].join("\n");
}

function main() {
  let files;
  try {
    files = readdirSync(ADMIN_OUT_DIR).filter((f) => f.endsWith(".html"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new Error(`out/ に .html が無い(先に next build を実行してください): ${ADMIN_OUT_DIR}`);
  }
  const htmlContents = files.map((f) => readFileSync(path.join(ADMIN_OUT_DIR, f), "utf8"));
  const deliveryOrigin = (process.env.NEXT_PUBLIC_DELIVERY_ORIGIN ?? "").replace(/\/$/, "");
  const content = buildAdminHeadersFile({ htmlContents, deliveryOrigin });
  writeFileSync(path.join(ADMIN_OUT_DIR, "_headers"), content);
  console.log(`OK  out/_headers (${files.length} 件の .html からインラインscriptのハッシュを数えた)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
