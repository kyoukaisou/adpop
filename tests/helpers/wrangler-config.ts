/*
  `wrangler.delivery.jsonc` を読む(検査用)。**行コメント(//)を文字列の外でだけ**落としてから JSON として読む。
  ⚠ ブロックコメント(/* *\/)は使っていないので扱わない(使ったら JSON.parse が落ちて気づける)。
*/
import { readFileSync } from "node:fs";
import path from "node:path";

export type DeliveryWranglerConfig = {
  name?: string;
  main?: string;
  assets?: { directory?: string; binding?: string };
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string; migrations_dir?: string }>;
  [key: string]: unknown;
};

export function stripLineComments(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

export const DELIVERY_WRANGLER_PATH = path.resolve(__dirname, "../../wrangler.delivery.jsonc");
export const ADMIN_WRANGLER_PATH = path.resolve(__dirname, "../../wrangler.admin.jsonc");

export function readWranglerConfig(file: string): DeliveryWranglerConfig {
  return JSON.parse(stripLineComments(readFileSync(file, "utf8"))) as DeliveryWranglerConfig;
}

export function readDeliveryWranglerConfig(): DeliveryWranglerConfig {
  return readWranglerConfig(DELIVERY_WRANGLER_PATH);
}
