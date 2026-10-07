/*
  両 Worker が Custom Domain(ホスト名の完全一致)で受けていて、workers.dev と zone の routes の
  どちらにも頼っていないかを見る純粋関数。判定はこの1本だけが持つ。

  🔴 **zone の routes(パターンで受ける方式)は使わない。** 同じホスト名に一致する zone の route は、
  Custom Domain の Worker より前に走る(Cloudflare 公式文書「Custom Domains」)。広い pattern を
  持つ別の Worker が1つ増えるだけで、配信・管理画面の通信を横取りできる経路になる。この検査は
  `custom_domain: true` が付いていない route(= zone の route)を**1件でも**見つけたら落とす。

  🔴 **workers_dev は明示的に false でなければ落とす。** ダッシュボードで切るだけでは次の deploy で
  戻る(Cloudflare 公式文書「workers.dev」)ため、設定ファイルの値そのものを見る。

  🔴 **custom domain のホストは、確定した配信元・管理画面のホストと完全一致しなければ落とす。**
  配信側は `deploy/delivery-origin.txt`(単独の正。scripts/delivery-origin-guard.mjs)の値から
  スキームを外したものと比べる。管理画面には同種の「確定値を1か所だけ持つファイル」がまだ無いため、
  このファイルの `ADMIN_CUSTOM_DOMAIN_HOST` を正として持つ。
*/

/** 管理画面の Custom Domain のホスト名(確定値)。 */
export const ADMIN_CUSTOM_DOMAIN_HOST = "adpop-admin.kyoukaisou.dev";

/**
 * `workers_dev` が明示的に `false` になっているかを見る。問題が無ければ `[]`。
 */
export function workersDevDisabledProblems({ label, workersDev }) {
  if (workersDev !== false) {
    return [`${label}: workers_dev が false になっていない(現在=${JSON.stringify(workersDev)})`];
  }
  return [];
}

/**
 * `routes` が「Custom Domain だけで、期待したホスト名1件に完全一致している」かを見る。
 * 問題が無ければ `[]`。
 * - `routes` が無い/配列でない/空 → 問題
 * - `custom_domain: true` が付いていない route(= zone の route)が1件でもある → 問題
 * - `pattern` の一覧が期待したホスト名1件とちょうど一致しない → 問題
 */
/** `route` オブジェクトが持つことを許す鍵は、この2つだけ(`pattern` と `custom_domain`)。 */
const ALLOWED_ROUTE_KEYS = ["pattern", "custom_domain"];

export function customDomainRouteProblems({ label, routes, expectedHost }) {
  const problems = [];

  if (!Array.isArray(routes) || routes.length === 0) {
    problems.push(`${label}: routes が無い(Custom Domain の設定が無い)`);
    return problems;
  }

  for (const route of routes) {
    if (typeof route !== "object" || route === null) {
      problems.push(`${label}: routes の要素が object ではない: ${JSON.stringify(route)}`);
      continue;
    }
    if (route.custom_domain !== true) {
      problems.push(`${label}: zone の routes(custom_domain: true が付いていない route)がある: ${JSON.stringify(route)}`);
    }
    // 🔴 レビュー指摘への対応: `custom_domain: true` だけでは、`zone_name`/`zone_id`(zone の route の鍵)・
    //   `enabled: false`(Cloudflare の公式スキーマに在る。無効化されていても検査は合格してしまう)・
    //   `previews_enabled` が混ざっていても合格してしまう。route オブジェクトは
    //   `pattern`・`custom_domain` の2つの鍵だけを許し、他の鍵が1つでもあれば落とす。
    const extraKeys = Object.keys(route).filter((key) => !ALLOWED_ROUTE_KEYS.includes(key));
    if (extraKeys.length > 0) {
      problems.push(
        `${label}: route に ${ALLOWED_ROUTE_KEYS.join("・")} 以外の鍵がある(${extraKeys.join("・")}): ${JSON.stringify(route)}`,
      );
    }
  }

  const patterns = routes.map((route) => (route && typeof route === "object" ? route.pattern : undefined)).filter(Boolean);

  if (patterns.length !== 1 || patterns[0] !== expectedHost) {
    problems.push(
      `${label}: custom domain のホストが確定値と一致しない(期待=${JSON.stringify([expectedHost])} / 実際=${JSON.stringify(patterns)})`,
    );
  }

  return problems;
}
