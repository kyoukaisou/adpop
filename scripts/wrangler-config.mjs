/*
  `wrangler.*.jsonc` を読む共通ユーティリティ(JSON コメント以外は書き換えない)。
  `tests/helpers/wrangler-config.ts` と、deploy 前の検査(`scripts/check-*.mjs`)の両方が
  この1本だけを使う(読み方を2つ持たない。Codex r1 Blocker 4 への対応)。
  ⚠ ブロックコメント(/* *\/)は使っていないので扱わない(使ったら JSON.parse が落ちて気づける)。
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DELIVERY_WRANGLER_PATH = path.join(REPO_ROOT, "wrangler.delivery.jsonc");
export const ADMIN_WRANGLER_PATH = path.join(REPO_ROOT, "wrangler.admin.jsonc");

export function stripLineComments(source) {
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

export function readWranglerConfig(file) {
  return JSON.parse(stripLineComments(readFileSync(file, "utf8")));
}
