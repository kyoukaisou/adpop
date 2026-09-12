// @vitest-environment node
//
// 配信エンドポイント2本の検査。**ルートハンドラを本物のまま呼ぶ**。
//
// ⚠ **差し替えるのは DB へ行く1枚(`@/lib/db/delivery`)だけ。**
//   ここが測るのは **ルートの振る舞い**(状態コード・CORS・本文の上限・理由の写し方)。
// 🔴 **「どの資格で DB へ繋いでいるか」はここでは測れない。**
//   それは `scripts/check-delivery-role.mjs` が**本物の専用ロールで実際に繋いで**測る
//   (できること2件 / できないこと8件)。
//   ⚠ 前の版はここで `fetch` を差し替えて「鍵が正しいこと」まで測ったつもりでいたが、
//     **その鍵が Auth や Storage に何をできるかは1バイトも測っていなかった**。
//     **測れる場所で測る**、に分け直した。
//
// 🔴 **CORS のヘッダは「許可した」という宣言**なので、断ったときに付いていないことを毎回見る。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/delivery", () => ({
  fetchSiteConfig: vi.fn(),
  recordEvent: vi.fn(),
}));

import { GET as getConfig } from "@/app/api/v1/config/route";
import { POST as postEvent } from "@/app/api/v1/events/route";
import { fetchSiteConfig, recordEvent } from "@/lib/db/delivery";

const SITE_KEY = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://lp.example.com";

const configRequest = (options: { origin?: string | null; siteKey?: string | null } = {}) => {
  const url = new URL("https://delivery.example.com/api/v1/config");
  const siteKey = options.siteKey === undefined ? SITE_KEY : options.siteKey;
  if (siteKey !== null) url.searchParams.set("site_key", siteKey);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  return new Request(url, { headers: origin === null ? {} : { origin } });
};

const eventRequest = (
  body: string,
  options: { origin?: string | null; siteKey?: string | null } = {},
) => {
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

/** 🔴 断ったときは CORS のヘッダが**1つも**付いていないこと。 */
function expectNoCors(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

beforeEach(() => {
  vi.mocked(fetchSiteConfig).mockReset();
  vi.mocked(recordEvent).mockReset();
  // 上流の失敗をログに出すのは正しい挙動なので、出力だけ黙らせる(呼ばれたことは測る)
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/config", () => {
  it("✅ 設定が返ると 200 + CORS(呼んできた Origin)+ Vary", async () => {
    const config = { v: 1, popup: { key: "p".repeat(32) } };
    vi.mocked(fetchSiteConfig).mockResolvedValue({ ok: true, data: config });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(config);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    // 🔴 認可の結果はキャッシュさせない
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("🔴 サイトキーと Origin をそのまま DB の関数へ渡す(こちらで作り変えない)", async () => {
    vi.mocked(fetchSiteConfig).mockResolvedValue({ ok: true, data: { v: 1 } });

    await getConfig(configRequest());

    expect(fetchSiteConfig).toHaveBeenCalledExactlyOnceWith(SITE_KEY, ORIGIN);
  });

  it("🔴 Origin ヘッダが無ければ 403 で、DB を1度も呼ばない", async () => {
    const response = await getConfig(configRequest({ origin: null }));

    expect(response.status).toBe(403);
    expectNoCors(response);
    expect(fetchSiteConfig, "断るべき要求を DB まで運んだ").not.toHaveBeenCalled();
  });

  it("サイトキーが無ければ 400 で、DB を1度も呼ばない", async () => {
    const response = await getConfig(configRequest({ siteKey: null }));

    expect(response.status).toBe(400);
    expectNoCors(response);
    expect(fetchSiteConfig).not.toHaveBeenCalled();
  });

  it("🔴 許可されていない(= 関数が null)なら 403 で、CORS を付けない", async () => {
    vi.mocked(fetchSiteConfig).mockResolvedValue({ ok: true, data: null });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "not_allowed" });
    expectNoCors(response);
  });

  it("🔴 DB へ届かなければ 502。**握り潰さずログに残す**", async () => {
    vi.mocked(fetchSiteConfig).mockResolvedValue({
      ok: false,
      kind: "upstream",
      detail: "connect ETIMEDOUT",
    });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(502);
    expectNoCors(response);
    expect(console.error).toHaveBeenCalledOnce();
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("ETIMEDOUT");
  });

  it("🔴 42501(EXECUTE の配り漏れ)も 502 として残す。**静かに 0件にしない**", async () => {
    /*
      🔴 配り漏れると **配信だけが静かに止まる**(LP は fail-closed で無傷なので誰も気づかない)。
        **「ポップが出ない」で終わらせない。**
    */
    vi.mocked(fetchSiteConfig).mockResolvedValue({
      ok: false,
      kind: "upstream",
      detail: 'permission denied for function adpop_site_config (42501)',
    });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(502);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("42501");
  });

  it("🔴 接続文字列が無ければ 503(「許可されていない」と混ぜない)", async () => {
    vi.mocked(fetchSiteConfig).mockResolvedValue({
      ok: false,
      kind: "config",
      detail: "ADPOP_DATABASE_URL が設定されていません",
    });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(503);
    expect(console.error).toHaveBeenCalledOnce();
  });
});

describe("POST /api/v1/events", () => {
  const event = JSON.stringify({ kind: "fire", popupKey: "p".repeat(32), device: "mobile" });

  it("✅ 受け付けたら 204(本文なし)+ CORS", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, data: { ok: true, stored: true } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await response.text()).toBe("");
  });

  it("⚠ 重複排除で落ちた(stored=false)のは失敗ではない = 204 のまま", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, data: { ok: true, stored: false } });

    expect((await postEvent(eventRequest(event))).status).toBe(204);
  });

  it("🔴 本文が上限(4KB)を超えたら 413 で、DB を1度も呼ばない", async () => {
    const huge = JSON.stringify({ kind: "fire", pageUrl: "x".repeat(5000) });

    const response = await postEvent(eventRequest(huge));

    expect(response.status).toBe(413);
    expect(recordEvent, "大きすぎる本文を DB まで運んだ").not.toHaveBeenCalled();
  });

  it("🔴 関数側の上限に当たったら 413(ルートで数え切れなかった分)", async () => {
    /*
      ⚠ ルートは**回線を流れるバイト**を数え、関数は**正規化した JSON のバイト**を数える。
        値は同じ 4096 でも**境界は一致しない**ので、両方から返りうる。
    */
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, data: { ok: false, reason: "too_large" } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, reason: "body_too_large" });
    expectNoCors(response);
  });

  it("壊れた JSON は 400 で、DB を1度も呼ばない", async () => {
    const response = await postEvent(eventRequest("{これは JSON ではない"));

    expect(response.status).toBe(400);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("🔴 サイト / Origin で断られたら 403(理由は統一されている)", async () => {
    /*
      ⚠ 関数が `site` と `origin` を撃ち分けなくなったので、ここも1つ。
        撃ち分けると**サイトキーの実在を判別できる**(総当たりで実在キーを選り分けられる)。
    */
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, data: { ok: false, reason: "not_allowed" } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "not_allowed" });
    expectNoCors(response);
  });

  it("形で断られたら 400 + 理由。⚠ **断るときは CORS を1つも付けない**", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, data: { ok: false, reason: "pageUrl" } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "pageUrl" });
    expectNoCors(response);
  });

  it("Origin が無ければ 403 で、DB を1度も呼ばない", async () => {
    const response = await postEvent(eventRequest(event, { origin: null }));

    expect(response.status).toBe(403);
    expectNoCors(response);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("🔴 DB へ渡すのは、受け取った本文そのまま(こちらで作り変えない)", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: true, data: { ok: true, stored: true } });

    await postEvent(eventRequest(event));

    expect(recordEvent).toHaveBeenCalledExactlyOnceWith(SITE_KEY, ORIGIN, JSON.parse(event));
  });

  it("🔴 DB へ届かなければ 502(こちらの設定の問題と混ぜない)", async () => {
    vi.mocked(recordEvent).mockResolvedValue({ ok: false, kind: "upstream", detail: "ECONNREFUSED" });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(502);
    expectNoCors(response);
    expect(console.error).toHaveBeenCalledOnce();
  });
});
