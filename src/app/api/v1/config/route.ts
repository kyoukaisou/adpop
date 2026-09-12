/*
  GET /api/v1/config?site_key=… —— **そのサイトの、いま有効なポップの設定**を返す。

  🔴 **認可はここに書かない。** サイトキー × Origin × 許可ドメインの判定は
    `adpop_site_config`(`security definer`)が持つ。ここがやるのは
    ①要求の形を見る ②Origin ヘッダを渡す ③**null を 403 に翻訳する**、の3つだけ。
  🔴 **fail-closed**: 設定が引けない・DB が落ちた・許可されていない —— どの場合も
    **CORS のヘッダを1つも付けない**。埋め込みスクリプト側は取得に失敗した扱いになり、
    **ポップが出ないだけで LP は無傷**(要件書 §5-2)。
*/
import { NextResponse } from "next/server";
import { corsHeaders, NO_STORE, originProblem, siteKeyProblem } from "@/lib/api/http";
import { fetchSiteConfig } from "@/lib/db/delivery";

/** ⚠ 認可の結果を返すので、静的化も ISR もしない。 */
export const dynamic = "force-dynamic";
/** ⚠ DB へ直接つなぐので Node.js のランタイムが要る(Edge では動かない)。 */
export const runtime = "nodejs";

function deny(status: number, reason: string): NextResponse {
  // 🔴 断るときは CORS のヘッダを1つも付けない(付けた時点で「許可した」と言っている)
  return NextResponse.json({ ok: false, reason }, { status, headers: { "cache-control": NO_STORE } });
}

export async function GET(request: Request): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  const originIssue = originProblem(origin);
  if (originIssue) return deny(originIssue.status, originIssue.reason);

  const siteKey = new URL(request.url).searchParams.get("site_key");
  const siteKeyIssue = siteKeyProblem(siteKey);
  if (siteKeyIssue) return deny(siteKeyIssue.status, siteKeyIssue.reason);

  const result = await fetchSiteConfig(siteKey as string, origin as string);

  if (!result.ok) {
    /*
      🔴 **握り潰さない。** 「設定を書き忘れた」と「許可ドメインを外した」は
        どちらも訪問者からは「ポップが出ない」に見えるので、**サーバーのログにだけは残す**。
      ⚠ 管理画面に届ける仕組みは PR3。**いまはログまで**、と書いておく。
    */
    console.error(`[adpop] config query failed (${result.kind}): ${result.detail}`);
    return deny(result.kind === "config" ? 503 : 502, result.kind);
  }

  // 🔴 null = サイトが無い / Origin が許可されていない / active なポップが無い。**区別しない。**
  if (result.data === null) return deny(403, "not_allowed");

  return NextResponse.json(result.data, {
    status: 200,
    headers: { ...corsHeaders(origin as string), "cache-control": NO_STORE },
  });
}
