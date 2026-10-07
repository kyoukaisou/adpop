#!/usr/bin/env node
/*
  `npm run deploy:delivery` / `npm run deploy:admin` が呼ぶ、唯一の正規 deploy 経路。
  判定(追加の CLI 引数を受け付けない理由)は `scripts/deploy-args-guard.mjs` を見てください。

  使い方:
    node scripts/guarded-deploy.mjs delivery
    node scripts/guarded-deploy.mjs admin
*/
import { spawnSync } from "node:child_process";
import { deployArgsGuardProblems } from "./deploy-args-guard.mjs";

const target = process.argv[2];
const extraArgs = process.argv.slice(3);

const problems = deployArgsGuardProblems({ target, extraArgs });
if (problems.length > 0) {
  for (const problem of problems) console.error(`NG  ${problem}`);
  process.exit(1);
}

const CONFIG_FILES = {
  delivery: "wrangler.delivery.jsonc",
  admin: "wrangler.admin.jsonc",
};

const result = spawnSync("npx", ["wrangler", "deploy", "-c", CONFIG_FILES[target]], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
