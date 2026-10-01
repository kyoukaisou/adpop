// @vitest-environment node
//
// Worker の設定ファイル(wrangler.*.jsonc)の値を固定する(security 監査 M7 / L9 / L11)。
// ⚠ 測っているのは「設定ファイルにそう書いてある」まで。Cloudflare 側で実際にそう効くかは、デプロイ後でないと測れない。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECRET_NAMES } from "../src/admin/config";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig } from "./helpers/wrangler-config";

type Config = {
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars?: Record<string, string>;
  observability?: { logs?: { invocation_logs?: boolean } };
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  d1_databases?: Array<{ binding: string; database_name: string }>;
};

describe.each([
  ["配信", DELIVERY_WRANGLER_PATH],
  ["管理画面", ADMIN_WRANGLER_PATH],
])("%s の Worker の設定", (_label, file) => {
  const config = readWranglerConfig(file) as Config;

  it("🔴 Version URL(preview_urls)を切り、workers_dev を明示している(既定値に頼らない・M7)", () => {
    expect(config.preview_urls).toBe(false);
    expect(config.workers_dev).toBe(true);
  });

  it("🔴 呼び出しのログ(invocation logs)を残さない(L11)", () => {
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });

  it("D1 と R2 のバインドが同じ名前で揃っている", () => {
    expect(config.d1_databases?.map((d) => [d.binding, d.database_name])).toEqual([["DB", "adpop"]]);
    expect(config.r2_buckets?.map((r) => [r.binding, r.bucket_name])).toEqual([["IMAGES", "adpop-images"]]);
  });

  it("🔴 秘密の鍵の名前が、設定ファイルのどこにも現れない(vars に書く事故を止める・L9)", () => {
    // ⚠ コメントの中の「書かない」という説明は許す。JSON として読んだ値の中に無いことを見る
    const values = JSON.stringify(config);
    for (const name of SECRET_NAMES) expect(values, name).not.toContain(name);
    expect(config.vars ?? {}).toEqual({});
  });
});

describe(".gitignore(L9)", () => {
  it("🔴 .dev.vars で始まるファイルを全部追跡しない(.dev.vars.production など)", () => {
    const lines = readFileSync(".gitignore", "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain(".dev.vars*");
  });
});
