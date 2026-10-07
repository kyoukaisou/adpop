// @vitest-environment node
//
// `tests/helpers/wrangler-config.ts` の `createTestWorkerConfig()` が、**実際に deploy しても
// 本番に当たらない形**の一時設定を作っているかを固定する(レビュー指摘)。
// 前巡の版は `build` だけを外していたため、Worker 名・本番の D1/R2・`assets` がそのまま残り、
// `wrangler deploy -c <生成したファイル>` で本番の Worker を検査無しで上書きできた。
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_WRANGLER_PATH,
  createTestWorkerConfig,
  DELIVERY_WRANGLER_PATH,
  readWranglerConfig,
} from "./helpers/wrangler-config";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe.each([
  ["管理画面", ADMIN_WRANGLER_PATH],
  ["配信", DELIVERY_WRANGLER_PATH],
])("%s の createTestWorkerConfig", (_label, sourcePath) => {
  it("🔴 生成した一時設定の name・database_id・bucket_name が、本番の設定のどれとも一致しない", () => {
    const production = readWranglerConfig(sourcePath);
    const testConfig = createTestWorkerConfig(sourcePath);
    cleanups.push(testConfig.cleanup);
    const generated = readWranglerConfig(testConfig.path);

    expect(generated.name).not.toBe(production.name);
    expect(generated.name).toMatch(new RegExp(`^${production.name}-test-[0-9a-f]+$`));

    const productionDatabaseIds = (production.d1_databases ?? []).map((d) => d.database_id);
    const generatedDatabaseIds = (generated.d1_databases ?? []).map((d) => d.database_id);
    expect(generatedDatabaseIds.length).toBeGreaterThan(0);
    for (const id of generatedDatabaseIds) {
      expect(productionDatabaseIds).not.toContain(id);
    }

    const productionBucketNames = (production.r2_buckets ?? []).map((r) => r.bucket_name);
    const generatedBucketNames = (generated.r2_buckets ?? []).map((r) => r.bucket_name);
    for (const name of generatedBucketNames) {
      expect(productionBucketNames).not.toContain(name);
    }
  });

  it("🔴 workers_dev が false・routes が無い・build が無い(本番として deploy しても本番と繋がらない)", () => {
    const testConfig = createTestWorkerConfig(sourcePath);
    cleanups.push(testConfig.cleanup);
    const generated = readWranglerConfig(testConfig.path);

    expect(generated.workers_dev).toBe(false);
    expect(generated.routes).toBeUndefined();
    expect(generated.build).toBeUndefined();
  });

  it("🔴 一時ファイルはリポジトリの外(os.tmpdir() の下)に置かれる", () => {
    const testConfig = createTestWorkerConfig(sourcePath);
    cleanups.push(testConfig.cleanup);
    const rel = path.relative(tmpdir(), testConfig.path);
    expect(rel.startsWith("..")).toBe(false);
  });

  it("main・assets.directory・migrations_dir は絶対パスで、実在するファイル/ディレクトリを指す", () => {
    const testConfig = createTestWorkerConfig(sourcePath);
    cleanups.push(testConfig.cleanup);
    const generated = readWranglerConfig(testConfig.path);

    expect(path.isAbsolute(generated.main as string)).toBe(true);
    expect(() => readFileSync(generated.main as string)).not.toThrow();

    if (generated.assets?.directory) {
      expect(path.isAbsolute(generated.assets.directory)).toBe(true);
    }
    for (const d of generated.d1_databases ?? []) {
      if (d.migrations_dir) expect(path.isAbsolute(d.migrations_dir)).toBe(true);
    }
  });

  it("cleanup() を呼ぶと一時ファイルが消える", () => {
    const testConfig = createTestWorkerConfig(sourcePath);
    expect(() => readFileSync(testConfig.path)).not.toThrow();
    testConfig.cleanup();
    expect(() => readFileSync(testConfig.path)).toThrow();
  });
});
