// @vitest-environment node
//
// 🔴 **配信の Worker を、実物の workerd で起動して**外から叩く(wrangler の `unstable_startWorker`)。
//   ここでしか測れないもの:
//     ① ソースが **Workers のランタイムで動く**(Node 固有の API を使っていない・束ねられる)
//     ② **設定(wrangler.delivery.jsonc)どおりに** D1 のバインドと静的配信がつながる
//     ③ 埋め込みスクリプトが `/embed/t.js` で配られ、キャッシュの指定(`_headers`)が載る
//   ⚠ D1 はローカルの複写(型紙 = 本番と同じ `wrangler d1 migrations apply` の結果)。本番の D1 ではない。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import * as admin from "../src/lib/data/admin";
import { openTestD1, OWNER_A, type TestD1 } from "./helpers/d1";
import { DELIVERY_WRANGLER_PATH } from "./helpers/wrangler-config";

const ORIGIN = "https://lp.example.com";

let t: TestD1;
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let siteKey = "";
let popupKey = "";

beforeAll(async () => {
  // 同じ永続化ディレクトリにデータを置いてから、Worker をそこへ向けて起動する
  t = await openTestD1();
  const db = t.db;
  await admin.ensureOwner(db, OWNER_A);
  const site = await admin.createSite(db, OWNER_A, { name: "A", allowedOrigins: [ORIGIN] });
  if (!site.ok) throw new Error("準備に失敗");
  const popup = await admin.createPopup(db, OWNER_A, site.value.id, { name: "A" });
  if (!popup.ok) throw new Error("準備に失敗");
  await admin.createVariant(db, OWNER_A, popup.value.id, {
    kind: "text",
    content: { headline: "見出し", body: "", buttonLabel: "" },
    destinationUrl: "https://offer.example.com/",
  });
  await admin.activatePopup(db, OWNER_A, popup.value.id);
  siteKey = (await db.prepare("select site_key from sites").first<{ site_key: string }>())!.site_key;
  popupKey = (await db.prepare("select public_key from popups").first<{ public_key: string }>())!.public_key;

  worker = await unstable_startWorker({
    config: DELIVERY_WRANGLER_PATH,
    dev: {
      // ⚠ ここは `--persist-to` と同じ根(`v3` は wrangler が足す)。getPlatformProxy とは渡し方が違う
      persist: t.persistDir,
      server: { port: 0 },
      inspector: false,
      logLevel: "none",
      watch: false,
    },
  });
  await worker.ready;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  await t?.dispose();
});

describe("配信の Worker(workerd で起動)", () => {
  it("🔴 ① ② 許可ドメインから設定が取れる(D1 のバインドがつながっている)", async () => {
    const response = await worker.fetch(`http://adpop.test/api/v1/config?site_key=${siteKey}`, {
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await response.json()) as { popup: { key: string } };
    expect(body.popup.key).toBe(popupKey);
  });

  it("🔴 許可していない Origin には 403・CORS なし", async () => {
    const response = await worker.fetch(`http://adpop.test/api/v1/config?site_key=${siteKey}`, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("✅ イベントを受けて 204・D1 に入る", async () => {
    const response = await worker.fetch(`http://adpop.test/api/v1/events?site_key=${siteKey}`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ kind: "fire", popupKey, device: "mobile", triggerKind: "exit_intent" }),
    });
    expect(response.status).toBe(204);
    const count = await t.db.prepare("select count(*) as c from events where kind = 'fire'").first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("🔴 ③ 埋め込みスクリプトが /embed/t.js で配られ、5分のキャッシュが載る", async () => {
    const response = await worker.fetch("http://adpop.test/embed/t.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect((await response.text()).length).toBeGreaterThan(100);
  });

  it("知らないパスは 404", async () => {
    expect((await worker.fetch("http://adpop.test/admin")).status).toBe(404);
  });
});
