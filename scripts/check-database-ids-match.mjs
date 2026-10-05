#!/usr/bin/env node
/*
  配信と管理画面、2つの wrangler 設定の `database_id` が一致していて、かつ仮の値ではないかを見る。
  違反があれば非ゼロで終わる。判定は `scripts/database-id-guard.mjs` の1本だけが持つ。
  `wrangler.delivery.jsonc` / `wrangler.admin.jsonc` の `build.command` から両方で呼ぶ
  (どちらを先に deploy してもこの検査を通る)。

  ⚠ `CI_DRY_RUN=1` のときだけ、**両方が仮の値のまま一致している**(= まだ D1 を作っていないだけで、
  config が壊れているわけではない)場合に限って許可する。実際の値のずれ(仮の値どうしでも違う値・
  片方だけ仮の値・一致しない実在値)は `CI_DRY_RUN=1` でも通さない。この変数は
  `.github/workflows/ci.yml` の dry-run ステップ以外では設定しない(本番の deploy では絶対に渡さないこと)。
*/
import { databaseIdMismatchProblems } from "./database-id-guard.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig } from "./wrangler-config.mjs";

const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH);
const admin = readWranglerConfig(ADMIN_WRANGLER_PATH);

const deliveryDatabaseId = delivery.d1_databases?.[0]?.database_id;
const adminDatabaseId = admin.d1_databases?.[0]?.database_id;

const problems = databaseIdMismatchProblems({ deliveryDatabaseId, adminDatabaseId });

if (problems.length > 0) {
  const onlyPlaceholderAndEqual =
    problems.every((p) => p.kind === "placeholder") && deliveryDatabaseId === adminDatabaseId;

  if (process.env.CI_DRY_RUN === "1" && onlyPlaceholderAndEqual) {
    console.log(
      "OK  (CI_DRY_RUN=1) database_id は仮の値のまま揃っている。本番の D1 を作るまでの既知の状態として許可する(docs/deploy.md 参照)。",
    );
    process.exit(0);
  }

  for (const problem of problems) console.error(`NG  ${problem.message}`);
  console.error("\n両方の wrangler.*.jsonc の d1_databases[0].database_id を、本番の D1 の id に差し替えてください(docs/deploy.md §2)。");
  process.exit(1);
}

console.log(`OK  wrangler.delivery.jsonc と wrangler.admin.jsonc の database_id が一致している(仮の値ではない)。`);
