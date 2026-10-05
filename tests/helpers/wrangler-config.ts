/*
  `wrangler.delivery.jsonc` を読む(検査用)。
  🔴 **JSONC の読み方そのものは `scripts/wrangler-config.mjs` の1本だけが持つ**
  (deploy 前の検査スクリプトと同じ読み方を使う。読み方を2つ持つと、片方だけ直した日にずれる)。
*/
import {
  ADMIN_WRANGLER_PATH,
  DELIVERY_WRANGLER_PATH,
  readWranglerConfig as readWranglerConfigJs,
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
