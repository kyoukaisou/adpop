import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/*
  ⚠ `FlatCompat` 経由で `next/core-web-vitals` を読むと eslint 9.39 + eslint-config-next 16 では
    `Converting circular structure to JSON` で落ちる(2026-09-08 実測)。
    eslint-config-next は**フラット設定を直接 export している**ので、そちらを使う。
*/
export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "next-env.d.ts",
    "packages/embed/dist/**",
    "supabase/.temp/**",
  ]),
  nextVitals,
  nextTs,
]);
