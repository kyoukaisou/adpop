/*
  検査ごとに**新しいローカル D1** を開く(型紙 = `wrangler d1 migrations apply` の結果を複写する)。
  バインドは `getPlatformProxy`(wrangler が workerd を起動して渡す実物の D1)。
*/
import type { D1Database } from "@cloudflare/workers-types";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inject } from "vitest";
import { getPlatformProxy } from "wrangler";
import { DELIVERY_WRANGLER_PATH } from "./wrangler-config";

export type TestD1 = { db: D1Database; persistDir: string; dispose: () => Promise<void> };

export async function openTestD1(): Promise<TestD1> {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-d1-"));
  cpSync(inject("d1Template"), dir, { recursive: true });
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: DELIVERY_WRANGLER_PATH,
    persist: { path: path.join(dir, "v3") },
  });
  return {
    db: proxy.env.DB,
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
