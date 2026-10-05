/*
  `wrangler.delivery.jsonc` を読む(検査用)。
  🔴 **JSONC の読み方そのものは `scripts/wrangler-config.mjs` の1本だけが持つ**
  (deploy 前の検査スクリプトと同じ読み方を使う。読み方を2つ持つと、片方だけ直した日にずれる)。
*/
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  workers_dev?: boolean;
  routes?: unknown;
  assets?: { directory?: string; binding?: string };
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string; migrations_dir?: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
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

/** テスト用の一時設定が database_id・bucket_name に使う、本番とは絶対に衝突しない値を作る(呼ぶたびに新しい乱数)。 */
function testOnlyIdentifiers(suffix: string) {
  return {
    databaseId: `test-only-d1-${suffix}`,
    bucketName: `test-only-r2-${suffix}`,
  };
}

/**
 * `sourcePath`(実物の `wrangler.*.jsonc`)の設定から、**実際に deploy しても本番に当たらない形**の
 * 一時設定を作る(Codex r4 Blocker への対応。以前の版は `build` だけを外していたため、
 * 残った Worker 名・本番の D1/R2・`assets` がそのままで、このファイルに対して
 * `wrangler deploy -c <このファイル>` を実行すれば本番 Worker を検査無しで上書きできた)。
 *
 * 変えるもの:
 * - `build`(= `build.command`)を外す。`unstable_startWorker` でも `build.command` は走る
 *   (Wrangler の仕様)ため、これが残っていると、配信元を確定していない間(docs/deploy.md §5)、
 *   admin 側の deploy 前の検査(別のテストで固定済み)に必ず引っかかる。
 *   `build` フィールドが無い設定では Wrangler はカスタムビルドを一切起動しないので、
 *   省略する「経路」を検査スクリプト自身に持たせる必要が無い。
 * - `name` を `<元の名前>-test-<乱数>` にする(**本番の Worker 名とは絶対に一致しない**。
 *   このファイルに対して deploy しても、別名の新しい Worker が作られるだけで本番には触れない)。
 * - `workers_dev` を `false`、`routes` を削除する(Version URL も実ルートも持たせない)。
 * - `d1_databases[].database_id` / `r2_buckets[].bucket_name` を、本番の値(仮の値であっても)
 *   とは絶対に衝突しない `test-only-*-<乱数>` に差し替える。
 * - `main` / `assets.directory` / `d1_databases[].migrations_dir` の**相対パスを絶対パスに書き換える**
 *   (このファイルはリポジトリの外、`os.tmpdir()` の下に置くため。相対パスのままだと設定ファイルの
 *   位置を基準に解決され、別ディレクトリでは壊れる)。
 *
 * ⚠ 一時ファイルは `os.tmpdir()` の下に置く(リポジトリの中には置かない。`.gitignore` で隠す方式はやめた
 *   ——隠しても、deploy できる形のファイルがリポジトリの中に存在すること自体が危険)。乱数つきの名前で
 *   並列実行でも衝突しない。
 */
export function createTestWorkerConfig(sourcePath: string): { path: string; cleanup: () => void } {
  const config = readWranglerConfig(sourcePath);
  const sourceDir = path.dirname(sourcePath);
  const suffix = randomBytes(6).toString("hex");
  const { databaseId, bucketName } = testOnlyIdentifiers(suffix);

  delete config.build;
  delete config.routes;
  config.name = `${config.name}-test-${suffix}`;
  config.workers_dev = false;

  if (typeof config.main === "string") {
    config.main = path.resolve(sourceDir, config.main);
  }
  if (config.assets && typeof config.assets.directory === "string") {
    config.assets = { ...config.assets, directory: path.resolve(sourceDir, config.assets.directory) };
  }
  if (Array.isArray(config.d1_databases)) {
    config.d1_databases = config.d1_databases.map((d) => ({
      ...d,
      database_id: databaseId,
      migrations_dir: typeof d.migrations_dir === "string" ? path.resolve(sourceDir, d.migrations_dir) : d.migrations_dir,
    }));
  }
  if (Array.isArray(config.r2_buckets)) {
    config.r2_buckets = config.r2_buckets.map((r) => ({ ...r, bucket_name: bucketName }));
  }

  const destPath = path.join(tmpdir(), `adpop-test-worker-${suffix}.jsonc`);
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
