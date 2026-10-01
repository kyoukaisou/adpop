/*
  配信の Worker。**LP に貼られたタグが呼ぶ口はここだけ**(管理画面は別の Worker = PR3b)。

    GET  /api/v1/config?site_key=…   そのサイトの、いま有効なポップの設定
    POST /api/v1/events?site_key=…   計測イベントを1件
    /embed/*                          埋め込みスクリプト(静的配信。**この Worker を起こさずに**配られる)
    GET  /img/<キー>                   パターンの画像(R2 のバインドから読む。PR3b)

  旧版は Next.js のルートハンドラ(src/app/api/v1/*)だった。旧版のルートの検査を移して(tests/delivery-routes.test.ts)
  同じ状態コード・CORS・理由になることを確かめた(⚠ 接続文字列・42501 の検査は、D1 に無いので D1 のバインド欠けに置き換えた)。
  **足したのは** 知らないパスの 404 と、メソッド違いの 405。
  🔴 **断るときは CORS のヘッダを1つも付けない**(理由を問わず)。付けた時点で「許可した」と言っている。
  🔴 **fail-closed**: 設定が引けない・DB に届かない・許可されていない —— どれも「ポップが出ないだけ」。
  ⚠ Node 固有の API を使わない(workerd で動く。`tests/d1-worker-runtime.test.ts` が実物の workerd で起動する)。
*/
import {
  corsHeaders,
  MAX_EVENT_BODY_BYTES,
  NO_STORE,
  originProblem,
  parseJsonObject,
  readBodyWithLimit,
  siteKeyProblem,
} from "../lib/api/http";
import { logFailure } from "../lib/log/redact";
import { hasDatabase, recordEvent, siteConfig, type DeliveryBindings } from "../lib/data/delivery";
import { readImage } from "../lib/data/image-read";

/**
 * 🔴 **この Worker は D1 の値に1度も触らない**(`env.DB` を読まない)。バインドの入れ物ごとデータ層へ渡す。
 *   データ層の外で D1 の値を参照していないことは `tests/d1-access-boundary.test.ts` が型で見る。
 */
export type DeliveryEnv = DeliveryBindings;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": NO_STORE, ...headers },
  });
}

function deny(status: number, reason: string): Response {
  return json({ ok: false, reason }, status);
}

/**
 * DB に届かなかった。**握り潰さない** —— 訪問者には「出ないだけ」だが、ログには残す。
 * 🔴 ログは**匿名化した1行だけ**(src/lib/log/redact.ts)。呼び出しのログは設定で切ってある(wrangler.delivery.jsonc)。
 */
function upstream(where: string, error: unknown): Response {
  logFailure(where, error);
  return deny(502, "upstream");
}

async function handleConfig(request: Request, env: DeliveryEnv): Promise<Response> {
  const origin = request.headers.get("origin");
  const originIssue = originProblem(origin);
  if (originIssue) return deny(originIssue.status, originIssue.reason);
  const siteKey = new URL(request.url).searchParams.get("site_key");
  const siteKeyIssue = siteKeyProblem(siteKey);
  if (siteKeyIssue) return deny(siteKeyIssue.status, siteKeyIssue.reason);

  let config;
  try {
    config = await siteConfig(env, siteKey as string, origin as string);
  } catch (error) {
    return upstream("config", error);
  }
  // 🔴 null = サイトが無い / Origin が許可されていない / 稼働中のポップが無い。**区別しない**
  if (config === null) return deny(403, "not_allowed");
  return json(config, 200, corsHeaders(origin as string));
}

async function handleEvents(request: Request, env: DeliveryEnv): Promise<Response> {
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
    outcome = await recordEvent(env, siteKey as string, origin as string, parsed.value);
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

/** 画像の URL(`/img/<32桁の16進>.<拡張子>`)。キーの形は `images.ts` の `readImage` がもう一度確かめる。 */
const IMAGE_PATH = /^\/img\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/;

/**
 * 画像を返す(PR3b)。🔴 **バケットは公開しない**。この Worker がバインドから読んで返す。
 * ⚠ キーは毎回新しい乱数なので中身は変わらない → 1年のキャッシュ(immutable)。
 *   ⚠ 削除しても、CDN・ブラウザのキャッシュには残りうる(README)。
 */
async function handleImage(request: Request, env: DeliveryEnv, name: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "method");
  let image;
  try {
    image = await readImage(env, `images/${name}`);
  } catch (error) {
    return upstream("image", error);
  }
  if (image === null) return deny(404, "not_found");
  return new Response(request.method === "HEAD" ? null : image.body, {
    status: 200,
    headers: {
      "content-type": image.contentType,
      "content-length": String(image.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleDelivery(request: Request, env: DeliveryEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const imageMatch = IMAGE_PATH.exec(pathname);
  if (imageMatch !== null) return handleImage(request, env, imageMatch[1]);
  const route =
    pathname === "/api/v1/config" ? "config" : pathname === "/api/v1/events" ? "events" : null;
  if (route === null) return deny(404, "not_found");
  if (route === "config" && request.method !== "GET") return deny(405, "method");
  if (route === "events" && request.method !== "POST") return deny(405, "method");
  // 🔴 バインドが無い = こちらの設定の問題(運用者に見せる)。訪問者には「出ないだけ」
  if (!hasDatabase(env)) {
    console.error("[adpop] D1 binding `DB` is missing");
    return deny(503, "config");
  }
  return route === "config" ? handleConfig(request, env) : handleEvents(request, env);
}

const deliveryWorker = {
  fetch(request: Request, env: DeliveryEnv): Promise<Response> {
    return handleDelivery(request, env);
  },
};

export default deliveryWorker;
