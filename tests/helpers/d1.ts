/*
  検査ごとに**新しいローカル D1** を開く(型紙 = `wrangler d1 migrations apply` の結果を複写する)。
  バインドは `getPlatformProxy`(wrangler が workerd を起動して渡す実物の D1)。
*/
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inject } from "vitest";
import { getPlatformProxy } from "wrangler";
import { DELIVERY_WRANGLER_PATH, REPO_ROOT } from "./wrangler-config";

export type TestD1 = {
  db: D1Database;
  /** 配信の設定(wrangler.delivery.jsonc)のバインド。R2(`IMAGES`)もローカル(Miniflare)のもの */
  images: R2Bucket;
  persistDir: string;
  dispose: () => Promise<void>;
};

/**
 * @param configPath 既定は実物の `wrangler.delivery.jsonc`(ただ D1/R2 のバインドを借りるだけで、
 *   deploy はしないので問題無い)。`unstable_startWorker` で実際に Worker も起動するテスト
 *   (`tests/d1-worker-runtime.test.ts`)は、**同じ一時設定**(`createTestWorkerConfig` が作った
 *   本番に当たらない設定)をここにも渡すこと。配信・Worker 側が別々の `database_id`/`bucket_name`
 *   を見てしまうと、ここで作った D1/R2 と Worker が別物を見て噛み合わない。
 *
 *   ⚠ **`configPath` が実物の `wrangler.delivery.jsonc` と違う(= `database_id` が違う)ときは、
 *   全体で1回だけ作った型紙(`inject("d1Template")`)を複写しない。** ローカルの D1 の永続化先の
 *   ファイル名は `database_id` から決まるハッシュで、`database_id` が違うと型紙を複写しても
 *   空の D1 として見える(実測: `wrangler d1 migrations apply` が作る sqlite ファイル名を
 *   `database_id` だけ変えて比べると、ハッシュが変わる)。その場合は、この `configPath` に対して
 *   直接 `wrangler d1 migrations apply --local` を1回流す。
 */
export async function openTestD1(configPath: string = DELIVERY_WRANGLER_PATH): Promise<TestD1> {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-d1-"));
  if (configPath === DELIVERY_WRANGLER_PATH) {
    cpSync(inject("d1Template"), dir, { recursive: true });
  } else {
    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "migrations",
        "apply",
        "adpop",
        "--local",
        "--persist-to",
        dir,
        "-c",
        configPath,
      ],
      { cwd: REPO_ROOT, stdio: "pipe", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
    );
  }
  const proxy = await getPlatformProxy<{ DB: D1Database; IMAGES: R2Bucket }>({
    configPath,
    persist: { path: path.join(dir, "v3") },
  });
  return {
    db: proxy.env.DB,
    images: proxy.env.IMAGES,
    persistDir: dir,
    dispose: async () => {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** D1 の失敗の文言を返す(通ったら空文字)。 */
export async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}
