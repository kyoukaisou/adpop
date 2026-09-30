/*
  🔴 **本番と同じ手順でスキーマを作る**: `wrangler d1 migrations apply --local` を1回だけ走らせ、
    できたローカルの D1(workerd の中の SQLite)を**型紙**にする。各検査はそれを複写して使う。
  ⚠ SQL を自前で文に分けて流さない —— トリガ本体の `;` の扱いなど、**適用の仕方そのものが本番と違う**と
    「本番では流れない SQL が検査では流れる」が起きる。
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

const ROOT = path.resolve(__dirname, "../..");

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-d1-template-"));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "migrations",
      "apply",
      "adpop",
      "--local",
      "--persist-to",
      dir,
      "-c",
      path.join(ROOT, "wrangler.delivery.jsonc"),
    ],
    { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
  // 静的配信の中身(t.js / adpop.js / _headers)を作る。配信の Worker を起動する検査が読む
  mkdirSync(path.join(ROOT, "dist/delivery-assets"), { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build-embed.mjs")], { cwd: ROOT, stdio: "pipe" });
  project.provide("d1Template", dir);
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    d1Template: string;
  }
}
