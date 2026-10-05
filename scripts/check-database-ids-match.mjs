#!/usr/bin/env node
/*
  配信と管理画面、2つの wrangler 設定の `database_id` が一致しているかを見る。違反があれば非ゼロで終わる。
  判定は `scripts/database-id-guard.mjs` の1本だけが持つ。
  `wrangler.delivery.jsonc` / `wrangler.admin.jsonc` の `build.command` から両方で呼ぶ
  (どちらを先に deploy してもこの検査を通る。Codex r1 Blocker 4)。
*/
import { databaseIdMismatchProblems } from "./database-id-guard.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig } from "./wrangler-config.mjs";

const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH);
const admin = readWranglerConfig(ADMIN_WRANGLER_PATH);

const problems = databaseIdMismatchProblems({
  deliveryDatabaseId: delivery.d1_databases?.[0]?.database_id,
  adminDatabaseId: admin.d1_databases?.[0]?.database_id,
});

if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem}`);
  console.error("\n両方の wrangler.*.jsonc の d1_databases[0].database_id を同じ値に揃えてください。");
  process.exit(1);
}

console.log(`OK  wrangler.delivery.jsonc と wrangler.admin.jsonc の database_id が一致している。`);
