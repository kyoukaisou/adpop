/*
  管理画面の Worker(`wrangler.admin.jsonc`)。いまは API(`/api/admin/*`)だけ。
  ⚠ 画面(Next の静的書き出し)は、拓実さんが見本を承認した後の PR で、この Worker の静的配信に載せる(D-301)。
*/
import { createAdminApp } from "./app";

const app = createAdminApp();

const adminWorker = {
  fetch: app.fetch,
};

export default adminWorker;
