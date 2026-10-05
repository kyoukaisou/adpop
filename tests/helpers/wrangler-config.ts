/*
  `wrangler.delivery.jsonc` を読む(検査用)。
  🔴 **JSONC の読み方そのものは `scripts/wrangler-config.mjs` の1本だけが持つ**
  (deploy 前の検査スクリプトと同じ読み方を使う。読み方を2つ持つと、片方だけ直した日にずれる)。
*/
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ADMIN_WRANGLER_PATH,
  DELIVERY_WRANGLER_PATH,
  readWranglerConfig as readWranglerConfigJs,
  REPO_ROOT,
  stripLineComments,
} from "../../scripts/wrangler-config.mjs";

export type DeliveryWranglerConfig = {
  name?: string;
  main?: string;
  assets?: { directory?: string; binding?: string };
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string; migrations_dir?: string }>;
  build?: { command?: string };
  [key: string]: unknown;
};

export { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, stripLineComments };

export function readWranglerConfig(file: string): DeliveryWranglerConfig {
  return readWranglerConfigJs(file) as DeliveryWranglerConfig;
}

export function readDeliveryWranglerConfig(): DeliveryWranglerConfig {
  return readWranglerConfig(DELIVERY_WRANGLER_PATH);
}

/**
 * `sourcePath` の設定から `build`(= `build.command`)だけを外した**一時的な別ファイル**を作る。
 * 🔴 **実物の `wrangler.*.jsonc` は一切書き換えない**(deploy 前の検査には絶対に書き込まない)。
 *   `build.command` は `unstable_startWorker` でも走る(Wrangler の仕様)ため、これを使わないと、
 *   このリポジトリがまだ本番の D1・配信元を確定していない間(docs/deploy.md §2・§5)、
 *   `tests/*.test.ts` が実物の worker を起動するたびに deploy 前の検査(check-database-ids-match.mjs・
 *   check-admin-headers.mjs)に必ず引っかかる。これらの検査自体は別のテスト
 *   (`tests/admin-config.test.ts`・`tests/delivery-origin-guard.test.ts`)で固定済みなので、
 *   実物の Worker の実行時の振る舞い(CSP・D1 のバインド等)を見るこの種のテストでは、
 *   deploy 前の検査を**もう一度**通す必要が無い(= build.command を省く)。
 *   `build` フィールドが無い設定では Wrangler はカスタムビルドを一切起動しないため、
 *   deploy 前の検査が実行されることも無い(省略する「経路」ではなく、そもそも呼ばれない)。
 * ⚠ 一時ファイルは `sourcePath` と同じディレクトリに置く(`assets.directory`・`migrations_dir` 等の
 *   相対パスが設定ファイルの位置を基準に解決されるため)。乱数つきの名前にして並列実行でも衝突しない。
 */
export function createTestWorkerConfig(sourcePath: string): { path: string; cleanup: () => void } {
  const config = readWranglerConfig(sourcePath) as Record<string, unknown>;
  delete config.build;
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, ".jsonc");
  const suffix = randomBytes(6).toString("hex");
  const destPath = path.join(dir, `${base}.test-worker.${suffix}.jsonc`);
  writeFileSync(destPath, JSON.stringify(config, null, 2));
  return {
    path: destPath,
    cleanup: () => {
      try {
        unlinkSync(destPath);
      } catch {
        // すでに無ければ問題無い
      }
    },
  };
}

export { REPO_ROOT };
