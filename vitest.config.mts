// ⚠ 拡張子が `.mts` なのは意図的。`.ts` だと Vite が CommonJS として読み、
//   「ESM syntax in a file loaded as CommonJS」の警告が CI のログに毎回出る(2026-09-08 実測)。
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // React のコンポーネント検査はまだ無い(管理画面 = PR3b)ので jsdom を既定にしない。
    environment: "node",
    // 端末のタイムゾーンで結果が変わる検査を作らないため、常に UTC で走らせる。
    env: { TZ: "UTC" },
    /*
      🔴 **収集規則は包括的な1本だけにする。**
        置き場ごとに glob を並べると、1本消しても残りが緑になり、
        **新しい場所に置いた検査が1行も走らないまま緑**になる。
        1本なら、消した瞬間に収集が0件になって vitest 自体が失敗する。
    */
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "packages/embed/dist/**", "dist/**", ".wrangler/**"],
    /*
      ローカルの D1(workerd)を起動する検査は数秒かかる。
      既定の 5000ms だと**負荷で落ちる**(2026-09-03 実測)ので 30 秒にする。
      ⚠ これは「遅い検査を許す」設定ではない。5秒を超える検査が増えたら検査の重さを疑う。
    */
    testTimeout: 30_000,
    /*
      ⚠ `hookTimeout` は `testTimeout` とは**別枠**(既定 10 秒)。
        D1 や Worker を起動するのは `beforeAll` の中なので、
        ここを上げないと **検査そのものは速いのに束ごと落ちる**(2026-09-08 に実測: 10秒で時間切れ)。
    */
    hookTimeout: 60_000,
    /*
      🔴 ローカルの D1 の型紙を、**本番と同じ `wrangler d1 migrations apply`** で1回だけ作る
      (`tests/setup/d1-template.ts`)。D1 を使う検査はそれを複写して使う。
    */
    globalSetup: ["tests/setup/d1-template.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./src") },
  },
});
