/*
  POST /api/v1/events?site_key=… —— 計測イベントを1件受ける。

  受ける `kind`: `fire` / `suppressed` / `impression` / `click` / `close`(要件書 §4-7)。
  🔴 **`conversion` はここでは受けない。** CV 計測タグは PR6 の**別の入口**になる。

  🔴 **濫用の入口である**(誰でも叩ける・偽造できる = 要件書 §4-7)。
    v1 で入れている防御は3つだけ:
      ① **Origin** が許可ドメインに在ること(判定は DB)
      ② **サイトキーの存在確認**(同上)
      ③ **本文の大きさの上限**(4KB。**ここと DB の関数の両方**に置いてある)
    ⚠ **レート制限は入っていない**(PR4 以降)。README にそう書いてある。
*/
import { NextResponse } from "next/server";
import {
  corsHeaders,
  MAX_EVENT_BODY_BYTES,
  NO_STORE,
  originProblem,
  parseJsonObject,
  readBodyWithLimit,
  siteKeyProblem,
} from "@/lib/api/http";
import { recordEvent } from "@/lib/db/delivery";

export const dynamic = "force-dynamic";
/** ⚠ DB へ直接つなぐので Node.js のランタイムが要る(Edge では動かない)。 */
export const runtime = "nodejs";

/**
 * 🔴 **断るときは CORS のヘッダを1つも付けない**(理由を問わず)。
 *   ⚠ 代償はゼロ: 埋め込みスクリプトは `sendBeacon` で送るので**応答を1バイトも読まない**。
 */
function deny(status: number, reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status, headers: { "cache-control": NO_STORE } });
}

export async function POST(request: Request): Promise<NextResponse> {
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

  const result = await recordEvent(siteKey as string, origin as string, parsed.value);

  if (!result.ok) {
    console.error(`[adpop] events query failed (${result.kind}): ${result.detail}`);
    return deny(result.kind === "config" ? 503 : 502, result.kind);
  }

  const outcome = result.data;
  if (!outcome?.ok) {
    const reason = outcome?.reason ?? "unknown";
    /*
      🔴 **サイトキーの実在を判別させない。** 関数は `not_allowed` の1つにまとめて返すので、
        ここは 403 に写すだけ。
      ⚠ `too_large` は**関数側**の上限に当たった場合(ここは回線のバイト、
        関数は正規化した JSON のバイトを数えるので、値が同じでも境界が違う)。
    */
    if (reason === "not_allowed") return deny(403, "not_allowed");
    if (reason === "too_large") return deny(413, "body_too_large");
    return deny(400, reason);
  }

  /*
    ⚠ **204 を返す**(本文を作らない)。`navigator.sendBeacon` は応答を1バイトも読まない。
    ⚠ **重複排除で落ちたことは「失敗」ではない**(要件書 §4-7)。だからここは 204 のまま。
  */
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(origin as string), "cache-control": NO_STORE },
  });
}
