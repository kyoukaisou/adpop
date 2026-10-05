/*
  管理画面の Worker(`wrangler.admin.jsonc`)。API(`/api/admin/*`)はこの Hono アプリが持つ。
  画面(Next の静的書き出し `out/`)は `wrangler.admin.jsonc` の `assets` が静的配信する
  (`run_worker_first: ["/api/*"]` で `/api/*` だけこの fetch を通す。D-301・PR3c)。
*/
import { createAdminApp } from "./app";

const app = createAdminApp();

const adminWorker = {
  fetch: app.fetch,
};

export default adminWorker;
