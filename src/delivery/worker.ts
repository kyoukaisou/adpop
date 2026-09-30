/*
  配信の Worker。**LP に貼られたタグが呼ぶ口はここだけ**(管理画面は別の Worker = PR3b)。

    GET  /api/v1/config?site_key=…   そのサイトの、いま有効なポップの設定
    POST /api/v1/events?site_key=…   計測イベントを1件
    /embed/*                          埋め込みスクリプト(静的配信。**この Worker を起こさずに**配られる)

  旧版は Next.js のルートハンドラ(src/app/api/v1/*)だった。**振る舞い(状態コード・CORS・理由の写し方)は同じ**。
  🔴 **断るときは CORS のヘッダを1つも付けない**(理由を問わず)。付けた時点で「許可した」と言っている。
  🔴 **fail-closed**: 設定が引けない・DB に届かない・許可されていない —— どれも「ポップが出ないだけ」。
  ⚠ Node 固有の API を使わない(workerd で動く。`tests/d1-worker-runtime.test.ts` が実物の workerd で起動する)。
*/
import type { D1Database } from "@cloudflare/workers-types";
import {
  corsHeaders,
  MAX_EVENT_BODY_BYTES,
  NO_STORE,
  originProblem,
  parseJsonObject,
  readBodyWithLimit,
  siteKeyProblem,
} from "../lib/api/http";
import { recordEvent, siteConfig } from "../lib/data/delivery";

export type DeliveryEnv = { DB?: D1Database };

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": NO_STORE, ...headers },
  });
}

function deny(status: number, reason: string): Response {
  return json({ ok: false, reason }, status);
}

/** DB に届かなかった。**握り潰さない** —— 訪問者には「出ないだけ」だが、ログには残す。 */
function upstream(where: string, error: unknown): Response {
  console.error(`[adpop] ${where} failed: ${error instanceof Error ? error.message : String(error)}`);
  return deny(502, "upstream");
}

async function handleConfig(request: Request, db: D1Database): Promise<Response> {
  const origin = request.headers.get("origin");
  const originIssue = originProblem(origin);
  if (originIssue) return deny(originIssue.status, originIssue.reason);
  const siteKey = new URL(request.url).searchParams.get("site_key");
  const siteKeyIssue = siteKeyProblem(siteKey);
  if (siteKeyIssue) return deny(siteKeyIssue.status, siteKeyIssue.reason);

  let config;
  try {
    config = await siteConfig(db, siteKey as string, origin as string);
  } catch (error) {
    return upstream("config", error);
  }
  // 🔴 null = サイトが無い / Origin が許可されていない / 稼働中のポップが無い。**区別しない**
  if (config === null) return deny(403, "not_allowed");
  return json(config, 200, corsHeaders(origin as string));
}

async function handleEvents(request: Request, db: D1Database): Promise<Response> {
  const origin = request.headers.get("origin");
  const originIssue = originProblem(origin);
  if (originIssue) return deny(originIssue.status, originIssue.reason);
  const siteKey = new URL(request.url).searchParams.get("site_key");
  const siteKeyIssue = siteKeyProblem(siteKey);
  if (siteKeyIssue) return deny(siteKeyIssue.status, siteKeyIssue.reason);

  const body = await readBodyWithLimit(request.body, MAX_EVENT_BODY_BYTES);
  if ("problem" in body) return deny(body.problem.status, body.problem.reason);
  const parsed = parseJsonObject(body.text);
  if ("problem" in parsed) return deny(parsed.problem.status, parsed.problem.reason);

  let outcome;
  try {
    outcome = await recordEvent(db, siteKey as string, origin as string, parsed.value);
  } catch (error) {
    return upstream("events", error);
  }
  if (!outcome.ok) {
    if (outcome.reason === "not_allowed") return deny(403, "not_allowed");
    if (outcome.reason === "too_large") return deny(413, "body_too_large");
    return deny(400, outcome.reason);
  }
  // ⚠ 204(本文なし)。`sendBeacon` は応答を読まない。重複排除で入らなかったのも失敗ではない
  return new Response(null, { status: 204, headers: { ...corsHeaders(origin as string), "cache-control": NO_STORE } });
}

export async function handleDelivery(request: Request, env: DeliveryEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route =
    pathname === "/api/v1/config" ? "config" : pathname === "/api/v1/events" ? "events" : null;
  if (route === null) return deny(404, "not_found");
  if (route === "config" && request.method !== "GET") return deny(405, "method");
  if (route === "events" && request.method !== "POST") return deny(405, "method");
  // 🔴 バインドが無い = こちらの設定の問題(運用者に見せる)。訪問者には「出ないだけ」
  if (env.DB === undefined) {
    console.error("[adpop] D1 binding `DB` is missing");
    return deny(503, "config");
  }
  return route === "config" ? handleConfig(request, env.DB) : handleEvents(request, env.DB);
}

const deliveryWorker = {
  fetch(request: Request, env: DeliveryEnv): Promise<Response> {
    return handleDelivery(request, env);
  },
};

export default deliveryWorker;
