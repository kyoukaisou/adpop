#!/usr/bin/env node
/*
  両 Worker が Custom Domain(workers_dev: false・zone の routes を使わない・ホスト名が確定値と
  完全一致)で受けているかを見る。違反があれば非ゼロで終わる。判定は
  `scripts/custom-domain-guard.mjs` の1本だけが持つ。`wrangler.delivery.jsonc` /
  `wrangler.admin.jsonc` の `build.command` から両方で呼ぶ(どちらの Worker を先に deploy しても
  この検査が走る)。

  🔴 **省略する経路は無い。** 本番の `wrangler deploy` に何を渡しても、この検査を素通りさせる
  フラグ・環境変数は無い。
*/
import { ADMIN_CUSTOM_DOMAIN_HOST, customDomainRouteProblems, workersDevDisabledProblems } from "./custom-domain-guard.mjs";
import { readExpectedDeliveryOrigin } from "./delivery-origin-guard.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig } from "./wrangler-config.mjs";

const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH);
const admin = readWranglerConfig(ADMIN_WRANGLER_PATH);

// 配信の期待ホストは、deploy/delivery-origin.txt(単独の正)の確定値からスキームを外したもの。
const expectedDeliveryOrigin = readExpectedDeliveryOrigin();
const expectedDeliveryHost = expectedDeliveryOrigin.replace(/^https?:\/\//, "").replace(/\/+$/, "");

const problems = [
  ...workersDevDisabledProblems({ label: "配信", workersDev: delivery.workers_dev }),
  ...workersDevDisabledProblems({ label: "管理画面", workersDev: admin.workers_dev }),
  ...customDomainRouteProblems({ label: "配信", routes: delivery.routes, expectedHost: expectedDeliveryHost }),
  ...customDomainRouteProblems({ label: "管理画面", routes: admin.routes, expectedHost: ADMIN_CUSTOM_DOMAIN_HOST }),
];

if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem}`);
  console.error(
    "\n両 wrangler.*.jsonc の routes(custom_domain: true のホスト名1件だけ)・workers_dev: false を確認してください(docs/deploy.md)。",
  );
  process.exit(1);
}

console.log(`OK  配信・管理画面とも Custom Domain(workers_dev: false・zone の routes 無し)で確定ホストを受けている。`);
