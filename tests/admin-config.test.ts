// @vitest-environment node
//
// Worker の設定ファイル(wrangler.*.jsonc)の値を固定する(security 監査 M7 / L9 / L11)。
// ⚠ 測っているのは「設定ファイルにそう書いてある」まで。Cloudflare 側で実際にそう効くかは、デプロイ後でないと測れない。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECRET_NAMES } from "../src/admin/config";
import { databaseIdMismatchProblems, isPlaceholderDatabaseId, PLACEHOLDER_DATABASE_ID } from "../scripts/database-id-guard.mjs";
import { ADMIN_WRANGLER_PATH, DELIVERY_WRANGLER_PATH, readWranglerConfig } from "./helpers/wrangler-config";

type Config = {
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars?: Record<string, string>;
  observability?: { logs?: { invocation_logs?: boolean } };
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  d1_databases?: Array<{ binding: string; database_name: string; database_id?: string }>;
  build?: { command?: string };
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

describe("2つの wrangler 設定の database_id(Codex r1 Blocker 4 / r2 Blocker 1)", () => {
  it("現在のリポジトリの状態: 両方とも本番 D1(D-344)の実在の id で一致していて、仮の値ではない", () => {
    // `wrangler d1 create adpop` で作った本番の D1 の id(docs/deploy.md §2)。
    // 🔴 ここは「仮の値ではない」「2つが一致している」だけでは、両ファイルが同じ誤った値や
    //   CI 専用の値(`ci-dryrun-not-a-real-database-id` 等)に化けても通ってしまう(Codex r1 Blocker)。
    //   本部が確認した本番 D1 の id と**完全一致**することまで固定する。
    const PRODUCTION_DATABASE_ID = "2d56e040-2e9a-4cb2-b431-2829cb488a96";
    const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH) as Config;
    const admin = readWranglerConfig(ADMIN_WRANGLER_PATH) as Config;
    expect(delivery.d1_databases?.[0]?.database_id).toBe(PRODUCTION_DATABASE_ID);
    expect(admin.d1_databases?.[0]?.database_id).toBe(PRODUCTION_DATABASE_ID);
    expect(delivery.d1_databases?.[0]?.database_id).not.toBe(PLACEHOLDER_DATABASE_ID);
    expect(admin.d1_databases?.[0]?.database_id).not.toBe(PLACEHOLDER_DATABASE_ID);

    const problems = databaseIdMismatchProblems({
      deliveryDatabaseId: delivery.d1_databases?.[0]?.database_id,
      adminDatabaseId: admin.d1_databases?.[0]?.database_id,
    });
    expect(problems).toEqual([]);
  });

  it("通る例: 両方とも実在の値で、かつ一致している", () => {
    expect(
      databaseIdMismatchProblems({
        deliveryDatabaseId: "11111111-aaaa-4bbb-8ccc-222222222222",
        adminDatabaseId: "11111111-aaaa-4bbb-8ccc-222222222222",
      }),
    ).toEqual([]);
  });

  it("🔴 落ちる例: id が割れていれば databaseIdMismatchProblems が検出する(判定そのものの検査)", () => {
    expect(databaseIdMismatchProblems({ deliveryDatabaseId: "a", adminDatabaseId: "b" }).length).toBeGreaterThan(0);
    expect(databaseIdMismatchProblems({ deliveryDatabaseId: "a", adminDatabaseId: undefined }).length).toBeGreaterThan(
      0,
    );
  });

  it("🔴 落ちる例: 仮の値どうしが一致していても断る(前巡は「非空かつ一致」しか見ておらず、ここを見逃した)", () => {
    const problems = databaseIdMismatchProblems({
      deliveryDatabaseId: PLACEHOLDER_DATABASE_ID,
      adminDatabaseId: PLACEHOLDER_DATABASE_ID,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.kind === "placeholder")).toBe(true);
  });

  it("🔴 落ちる例: 片方だけ仮の値(もう片方は実在の値)", () => {
    const problems = databaseIdMismatchProblems({
      deliveryDatabaseId: PLACEHOLDER_DATABASE_ID,
      adminDatabaseId: "11111111-aaaa-4bbb-8ccc-222222222222",
    });
    expect(problems.some((p) => p.kind === "placeholder")).toBe(true);
    expect(problems.some((p) => p.kind === "mismatch")).toBe(true);
  });

  it("isPlaceholderDatabaseId は定数と完全一致したときだけ true", () => {
    expect(isPlaceholderDatabaseId(PLACEHOLDER_DATABASE_ID)).toBe(true);
    expect(isPlaceholderDatabaseId("00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(isPlaceholderDatabaseId(undefined)).toBe(false);
  });
});

describe("build.command の配線(Codex r1 Should-fix 1)", () => {
  // 🔴 `build.command` からどれかの検査を外しても CI は気づかない(dry-run の前に別ステップで
  //   `npm run build` 等を一度は走らせているため)。この検査は**設定ファイルの文字列**を見て、
  //   deploy 前に必ず走るはずのコマンドが実際にそこへ書かれているかを固定する。

  it("🔴 管理画面: build.command が npm run build と check-admin-headers.mjs を含む", () => {
    const admin = readWranglerConfig(ADMIN_WRANGLER_PATH) as Config;
    const command = admin.build?.command ?? "";
    expect(command).toContain("npm run build");
    expect(command).toContain("scripts/check-admin-headers.mjs");
    expect(command).toContain("scripts/check-database-ids-match.mjs");
  });

  it("🔴 配信: build.command が build:embed・サイズ上限・ライセンス境界・database_id の一致を含む", () => {
    const delivery = readWranglerConfig(DELIVERY_WRANGLER_PATH) as Config;
    const command = delivery.build?.command ?? "";
    expect(command).toContain("npm run build:embed");
    expect(command).toContain("npm run check:bundle-size");
    expect(command).toContain("npm run check:embed-independence");
    expect(command).toContain("scripts/check-database-ids-match.mjs");
  });
});
