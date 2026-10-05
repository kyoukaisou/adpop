#!/usr/bin/env node
/*
  配信と管理画面、2つの wrangler 設定の `database_id` が一致していて、かつ仮の値ではないかを見る。
  違反があれば非ゼロで終わる。判定は `scripts/database-id-guard.mjs` の1本だけが持つ。
  `wrangler.delivery.jsonc` / `wrangler.admin.jsonc` の `build.command` から両方で呼ぶ
  (どちらを先に deploy してもこの検査を通る)。

  🔴 **省略する経路は無い。** 前巡の `CI_DRY_RUN` フラグは、このフラグを立てたまま
  `wrangler deploy` を直接実行すれば本番でも仮の値を許してしまう欠陥だったため削除した
  (Codex r3 Blocker)。CI は、この2ファイルを書き換える代わりに、実行するジョブのワークスペースの
  中だけで仮の値を CI 専用の実在しない値(コミットしない)に一時的に置き換えてから、この検査を
  **通常の経路のまま**通す(`.github/workflows/ci.yml` 参照)。
*/
import { databaseIdMismatchProblems } from "./database-id-guard.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig } from "./wrangler-config.mjs";

const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH);
const admin = readWranglerConfig(ADMIN_WRANGLER_PATH);

const deliveryDatabaseId = delivery.d1_databases?.[0]?.database_id;
const adminDatabaseId = admin.d1_databases?.[0]?.database_id;

const problems = databaseIdMismatchProblems({ deliveryDatabaseId, adminDatabaseId });

if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem.message}`);
  console.error("\n両方の wrangler.*.jsonc の d1_databases[0].database_id を、本番の D1 の id に差し替えてください(docs/deploy.md §2)。");
  process.exit(1);
}

console.log(`OK  wrangler.delivery.jsonc と wrangler.admin.jsonc の database_id が一致している(仮の値ではない)。`);
