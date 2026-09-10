// @vitest-environment node
//
// 配信エンドポイント2本の検査。**ルートハンドラを本物のまま呼ぶ**。
//
// 🔴 **上流(PostgREST)だけを差し替える。** `callRpc` をモックすると、
//   **鍵の付け方・URL の組み立て・応答の読み方**を1つも測らないまま緑になる。
//   → 差し替えるのは `fetch` 1つだけで、`src/lib/db/rpc.ts` は本物を通す。
//
// 🔴 **CORS のヘッダは「許可した」という宣言**なので、断ったときに付いていないことを毎回見る。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getConfig } from "@/app/api/v1/config/route";
import { POST as postEvent } from "@/app/api/v1/events/route";

const SITE_KEY = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://lp.example.com";
const SUPABASE_URL = "https://project.supabase.test";
const SERVICE_KEY = "service-role-key-for-test";

type UpstreamCall = { url: string; headers: Record<string, string>; body: unknown };
let calls: UpstreamCall[];

/** 上流の応答を決める。⚠ `null` を返すと「fetch が失敗した」を模す。 */
function stubUpstream(reply: { status?: number; json?: unknown } | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as unknown,
      });
      if (reply === null) throw new Error("upstream down");
      const status = reply.status ?? 200;
      return new Response(JSON.stringify(reply.json ?? null), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

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
  calls = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  // 上流の失敗をログに出すのは正しい挙動なので、出力だけ黙らせる(呼ばれたことは測る)
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/v1/config", () => {
  it("✅ 設定が返ると 200 + CORS(呼んできた Origin)+ Vary", async () => {
    const config = { v: 1, popup: { key: "p".repeat(32) } };
    stubUpstream({ json: config });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(config);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    // 🔴 認可の結果はキャッシュさせない
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("🔴 上流にはサーバー専用の鍵を付け、Origin をそのまま渡す", async () => {
    /*
      ⚠ **`NEXT_PUBLIC_` の付いた鍵を使わない。** 付いた鍵はクライアントのバンドルへ入るので、
        **やめたばかりの「誰でも直接叩ける」に戻る**(0004)。
    */
    stubUpstream({ json: { v: 1, popup: {} } });

    await getConfig(configRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SUPABASE_URL}/rest/v1/rpc/adpop_site_config`);
    expect(calls[0].headers.apikey).toBe(SERVICE_KEY);
    expect(calls[0].headers.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect(calls[0].body).toEqual({ p_site_key: SITE_KEY, p_origin: ORIGIN });
  });

  it("🔴 Origin ヘッダが無ければ 403 で、上流を1度も叩かない", async () => {
    stubUpstream({ json: null });

    const response = await getConfig(configRequest({ origin: null }));

    expect(response.status).toBe(403);
    expectNoCors(response);
    expect(calls, "断るべき要求を上流まで運んだ").toEqual([]);
  });

  it("サイトキーが無ければ 400 で、上流を1度も叩かない", async () => {
    stubUpstream({ json: null });

    const response = await getConfig(configRequest({ siteKey: null }));

    expect(response.status).toBe(400);
    expectNoCors(response);
    expect(calls).toEqual([]);
  });

  it("🔴 許可されていない(= 上流が null)なら 403 で、CORS を付けない", async () => {
    stubUpstream({ json: null });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "not_allowed" });
    expectNoCors(response);
  });

  it("🔴 上流が落ちたら 502。**握り潰さずログに残す**", async () => {
    stubUpstream(null);

    const response = await getConfig(configRequest());

    expect(response.status).toBe(502);
    expectNoCors(response);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("🔴 上流が 42501(権限が配られていない)を返したら 502。**静かに 0件にしない**", async () => {
    /*
      🔴 0001 を流し直して ⑥ の配り直しが効かないと、ここが 42501 になる
        **「ポップが出ない」で終わらせない。**
    */
    stubUpstream({ status: 401, json: { code: "42501", message: "permission denied" } });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(502);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("42501");
  });

  it("🔴 環境変数が無ければ 503(「許可されていない」と混ぜない)", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    stubUpstream({ json: null });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
    expect(console.error).toHaveBeenCalledOnce();
  });
});

describe("POST /api/v1/events", () => {
  const event = JSON.stringify({ kind: "fire", popupKey: "p".repeat(32), device: "mobile" });

  it("✅ 受け付けたら 204(本文なし)+ CORS", async () => {
    stubUpstream({ json: { ok: true, stored: true } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await response.text()).toBe("");
  });

  it("⚠ 重複排除で落ちた(stored=false)のは失敗ではない = 204 のまま", async () => {
    stubUpstream({ json: { ok: true, stored: false } });

    expect((await postEvent(eventRequest(event))).status).toBe(204);
  });

  it("🔴 本文が上限(4KB)を超えたら 413 で、上流を1度も叩かない", async () => {
    stubUpstream({ json: { ok: true } });
    const huge = JSON.stringify({ kind: "fire", pageUrl: "x".repeat(5000) });

    const response = await postEvent(eventRequest(huge));

    expect(response.status).toBe(413);
    expect(calls, "大きすぎる本文を上流まで運んだ").toEqual([]);
  });

  it("壊れた JSON は 400 で、上流を1度も叩かない", async () => {
    stubUpstream({ json: { ok: true } });

    const response = await postEvent(eventRequest("{これは JSON ではない"));

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("🔴 サイト / Origin で断られたら 403(理由は統一されている)", async () => {
    /*
      ⚠ 関数側が `site` と `origin` を撃ち分けなくなった(0004)ので、ここも1つ。
        撃ち分けると**サイトキーの実在を判別できる**(総当たりで実在キーを選り分けられる)。
    */
    stubUpstream({ json: { ok: false, reason: "not_allowed" } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "not_allowed" });
    expectNoCors(response);
  });

  it("形で断られたら 400 + 理由。⚠ **断るときは CORS を1つも付けない**", async () => {
    /*
      🔴 当初は「Origin を通った後の形の不正だけ CORS を付ける」にしていたが、
        **「断るときは付けない」という説明と食い違っていた**(Codex 1巡目の文言指摘)。
        → **説明のほうに実装を合わせた。** 分岐を持たないほうが、次に読む人が間違えない。
    */
    stubUpstream({ json: { ok: false, reason: "pageUrl" } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "pageUrl" });
    expectNoCors(response);
  });

  it("🔴 関数側の上限に当たったら 413(ルートで数え切れなかった分)", async () => {
    /*
      ⚠ ルートは**回線を流れるバイト**を数え、関数は**正規化した JSON のバイト**を数える。
        値は同じ 4096 でも**境界は一致しない**ので、両方から返りうる。
    */
    stubUpstream({ json: { ok: false, reason: "too_large" } });

    const response = await postEvent(eventRequest(event));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, reason: "body_too_large" });
    expectNoCors(response);
  });

  it("Origin が無ければ 403 で、上流を1度も叩かない", async () => {
    stubUpstream({ json: { ok: true } });

    const response = await postEvent(eventRequest(event, { origin: null }));

    expect(response.status).toBe(403);
    expectNoCors(response);
    expect(calls).toEqual([]);
  });

  it("🔴 上流には受け取った本文をそのまま渡す(こちらで作り変えない)", async () => {
    stubUpstream({ json: { ok: true, stored: true } });

    await postEvent(eventRequest(event));

    expect(calls[0].url).toBe(`${SUPABASE_URL}/rest/v1/rpc/adpop_record_event`);
    expect(calls[0].body).toEqual({
      p_site_key: SITE_KEY,
      p_origin: ORIGIN,
      p_event: JSON.parse(event),
    });
  });
});
