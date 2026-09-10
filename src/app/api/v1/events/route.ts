/*
  POST /api/v1/events?site_key=… —— 計測イベントを1件受ける。

  受ける `kind`: `fire` / `suppressed` / `impression` / `click` / `close`(要件書 §4-7)。
  🔴 **`conversion` はここでは受けない。** CV 計測タグは PR6 の**別の入口**になる
    (実装より広い口を先に開けない)。断りは 0003 の関数が返す。

  🔴 **濫用の入口である**(誰でも叩ける・偽造できる = 要件書 §4-7 の注記)。
    v1 で入れている防御は3つだけ:
      ① **Origin** が許可ドメインに在ること(判定は DB)
      ② **サイトキーの存在確認**(同上)
      ③ **本文の大きさの上限**(4KB。ここで数えながら読む)
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
import { callRpc, RPC } from "@/lib/db/rpc";

export const dynamic = "force-dynamic";

type RecordResult = { ok: boolean; stored?: boolean; reason?: string };

/**
 * 🔴 **断るときは CORS のヘッダを1つも付けない**(理由を問わず)。
 *   ⚠ 当初は「Origin を通った後の形の不正だけ付ける」にしていたが、
 *     **「断るときは付けない」という説明と食い違っていた**(Codex 1巡目の文言指摘)。
 *     → **説明のほうに実装を合わせた。** 分岐を持たないほうが、次に読む人が間違えない。
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

  const result = await callRpc<RecordResult>(RPC.recordEvent, {
    p_site_key: siteKey,
    p_origin: origin,
    p_event: parsed.value,
  });

  if (!result.ok) {
    console.error(`[adpop] events rpc failed (${result.kind}): ${result.detail}`);
    return deny(result.kind === "config" ? 503 : 502, result.kind);
  }

  const outcome = result.data;
  if (!outcome?.ok) {
    const reason = outcome?.reason ?? "unknown";
    /*
      🔴 **サイトキーの実在を判別させない**(Codex 1巡目 Astra Medium)。
        関数は `not_allowed` の1つにまとめて返す(0004)ので、ここは 403 に写すだけ。
      ⚠ `too_large` は関数側の上限に当たった場合。**ルートで数え切れなかった**ことを意味する
        (ルートは回線のバイト、関数は正規化した JSON のバイトを数えるので、値が同じでも境界が違う)。
    */
    if (reason === "not_allowed") return deny(403, "not_allowed");
    if (reason === "too_large") return deny(413, "body_too_large");
    return deny(400, reason);
  }

  /*
    ⚠ **204 を返す**(本文を作らない)。`navigator.sendBeacon` は応答を1バイトも読まないので、
      成功の詳細(`stored` が false = 重複排除で落ちた)を返しても誰も見ない。
    ⚠ **重複排除で落ちたことは「失敗」ではない**(要件書 §4-7)。だからここは 204 のまま。
  */
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(origin as string), "cache-control": NO_STORE },
  });
}
