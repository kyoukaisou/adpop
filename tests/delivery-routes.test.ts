// @vitest-environment node
//
// 配信の Worker(src/delivery/worker.ts)の**入口の振る舞い**を測る(旧版の Next.js のルートの検査を移した)。
// ⚠ **差し替えるのはデータ層(`src/lib/data/delivery`)だけ。** ここが測るのは
//   状態コード・CORS・本文の上限・理由の写し方。判定そのものは `tests/d1-delivery.test.ts` が実物の D1 で測る。
// 🔴 **CORS のヘッダは「許可した」という宣言**なので、断ったときに付いていないことを毎回見る。
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/data/delivery", () => ({
  siteConfig: vi.fn(),
  recordEvent: vi.fn(),
  hasDatabase: (env: { DB?: unknown }) => env.DB !== undefined,
}));

import { recordEvent, siteConfig } from "../src/lib/data/delivery";
import { handleDelivery } from "../src/delivery/worker";

const SITE_KEY = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://lp.example.com";
const DB = { binding: "fake" } as unknown as D1Database;
const env = { DB };

const configRequest = (options: { origin?: string | null; siteKey?: string | null; method?: string } = {}) => {
  const url = new URL("https://delivery.example.com/api/v1/config");
  const siteKey = options.siteKey === undefined ? SITE_KEY : options.siteKey;
  if (siteKey !== null) url.searchParams.set("site_key", siteKey);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  return new Request(url, { method: options.method ?? "GET", headers: origin === null ? {} : { origin } });
};

const eventRequest = (body: string, options: { origin?: string | null; siteKey?: string | null } = {}) => {
  const url = new URL("https://delivery.example.com/api/v1/events");
  const siteKey = options.siteKey === undefined ? SITE_KEY : options.siteKey;
  if (siteKey !== null) url.searchParams.set("site_key", siteKey);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  return new Request(url, {
    method: "POST",
    // ⚠ 埋め込みスクリプトは preflight を起こさないために text/plain で送る
    headers: origin === null ? {} : { origin, "content-type": "text/plain;charset=UTF-8" },
    body,
  });
};

function expectNoCors(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

beforeEach(() => {
  vi.mocked(siteConfig).mockReset();
  vi.mocked(recordEvent).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/config", () => {
  it("✅ 設定が返ると 200 + CORS(呼んできた Origin)+ Vary + no-store", async () => {
    const config = { v: 1, popup: { key: "p".repeat(32) } };
    vi.mocked(siteConfig).mockResolvedValue(config as never);
    const response = await handleDelivery(configRequest(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(config);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("🔴 サイトキーと Origin をそのままデータ層へ渡す(こちらで作り変えない)", async () => {
    vi.mocked(siteConfig).mockResolvedValue({ v: 1 } as never);
    await handleDelivery(configRequest(), env);
    expect(siteConfig).toHaveBeenCalledExactlyOnceWith(env, SITE_KEY, ORIGIN);
  });

  it("🔴 Origin ヘッダが無ければ 403 で、DB を1度も呼ばない", async () => {
    const response = await handleDelivery(configRequest({ origin: null }), env);
    expect(response.status).toBe(403);
    expectNoCors(response);
    expect(siteConfig, "断るべき要求を DB まで運んだ").not.toHaveBeenCalled();
  });

  it("サイトキーが無ければ 400 で、DB を1度も呼ばない", async () => {
    const response = await handleDelivery(configRequest({ siteKey: null }), env);
    expect(response.status).toBe(400);
    expectNoCors(response);
    expect(siteConfig).not.toHaveBeenCalled();
  });

  it("🔴 許可されていない(= null)なら 403 で、CORS を付けない", async () => {
    vi.mocked(siteConfig).mockResolvedValue(null);
    const response = await handleDelivery(configRequest(), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "not_allowed" });
    expectNoCors(response);
  });

  it("🔴 DB へ届かなければ 502。**握り潰さずログに残す**", async () => {
    vi.mocked(siteConfig).mockRejectedValue(new Error("D1_ERROR: Network connection lost"));
    const response = await handleDelivery(configRequest(), env);
    expect(response.status).toBe(502);
    expectNoCors(response);
    expect(console.error).toHaveBeenCalledOnce();
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("Network connection lost");
  });

  it("🔴 D1 のバインドが無ければ 503(「許可されていない」と混ぜない)・ログに残す", async () => {
    const response = await handleDelivery(configRequest(), {});
    expect(response.status).toBe(503);
    expectNoCors(response);
    expect(console.error).toHaveBeenCalledOnce();
    expect(siteConfig).not.toHaveBeenCalled();
  });

  it("GET 以外は 405 / 知らないパスは 404(どちらも CORS なし)", async () => {
    const post = await handleDelivery(configRequest({ method: "POST" }), env);
    expect(post.status).toBe(405);
    expectNoCors(post);
    const unknown = await handleDelivery(new Request("https://delivery.example.com/api/v1/other", { headers: { origin: ORIGIN } }), env);
    expect(unknown.status).toBe(404);
    expectNoCors(unknown);
  });
});

describe("POST /api/v1/events", () => {
  const event = JSON.stringify({ kind: "fire", popupKey: "p".repeat(32), device: "mobile" });

  it("✅ 受け付けたら 204(本文なし)+ CORS", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, stored: true });
    const response = await handleDelivery(eventRequest(event), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await response.text()).toBe("");
  });

  it("⚠ 重複排除で入らなかった(stored=false)のは失敗ではない = 204 のまま", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, stored: false });
    expect((await handleDelivery(eventRequest(event), env)).status).toBe(204);
  });

  it("🔴 本文が上限(4KB)を超えたら 413 で、DB を1度も呼ばない", async () => {
    const huge = JSON.stringify({ kind: "fire", pageUrl: "x".repeat(5000) });
    const response = await handleDelivery(eventRequest(huge), env);
    expect(response.status).toBe(413);
    expect(recordEvent, "大きすぎる本文を DB まで運んだ").not.toHaveBeenCalled();
  });

  it("🔴 データ層の上限に当たったら 413(回線のバイトと JSON のバイトは境界が一致しない)", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: false, reason: "too_large" });
    const response = await handleDelivery(eventRequest(event), env);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, reason: "body_too_large" });
    expectNoCors(response);
  });

  it("壊れた JSON は 400 で、DB を1度も呼ばない", async () => {
    const response = await handleDelivery(eventRequest("{これは JSON ではない"), env);
    expect(response.status).toBe(400);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("🔴 サイト / Origin で断られたら 403(理由は統一されている)", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: false, reason: "not_allowed" });
    const response = await handleDelivery(eventRequest(event), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "not_allowed" });
    expectNoCors(response);
  });

  it("形で断られたら 400 + 理由。⚠ 断るときは CORS を1つも付けない", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: false, reason: "pageUrl" });
    const response = await handleDelivery(eventRequest(event), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "pageUrl" });
    expectNoCors(response);
  });

  it("Origin が無ければ 403 で、DB を1度も呼ばない", async () => {
    const response = await handleDelivery(eventRequest(event, { origin: null }), env);
    expect(response.status).toBe(403);
    expectNoCors(response);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("🔴 データ層へ渡すのは、受け取った本文そのまま(こちらで作り変えない)", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, stored: true });
    await handleDelivery(eventRequest(event), env);
    expect(recordEvent).toHaveBeenCalledExactlyOnceWith(env, SITE_KEY, ORIGIN, JSON.parse(event));
  });

  it("🔴 DB へ届かなければ 502(こちらの設定の問題と混ぜない)", async () => {
    vi.mocked(recordEvent).mockRejectedValue(new Error("D1_ERROR: overloaded"));
    const response = await handleDelivery(eventRequest(event), env);
    expect(response.status).toBe(502);
    expectNoCors(response);
    expect(console.error).toHaveBeenCalledOnce();
  });
});
