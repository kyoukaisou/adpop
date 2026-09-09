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
 * 🔴 **Origin かサイトキーで断ったときは CORS のヘッダを付けない。**
 *   付けると「この Origin は許可されている」と言ってしまう。
 *   逆に**形が悪いだけ**(JSON が壊れている等)なら、DB が Origin を通した後なので付けてよい。
 */
function deny(status: number, reason: string, origin?: string): NextResponse {
  return NextResponse.json(
    { ok: false, reason },
    { status, headers: { ...(origin ? corsHeaders(origin) : {}), "cache-control": NO_STORE } },
  );
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
    // 🔴 サイト・Origin で断られたときだけ、CORS を付けずに 403
    if (reason === "site" || reason === "origin") return deny(403, "not_allowed");
    return deny(400, reason, origin as string);
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
