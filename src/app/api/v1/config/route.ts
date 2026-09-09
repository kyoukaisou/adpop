/*
  GET /api/v1/config?site_key=… —— **そのサイトの、いま有効なポップの設定**を返す。

  🔴 **認可はここに書かない。** サイトキー × Origin × 許可ドメインの判定は
    0003 の `adpop_site_config`(`security definer`)が持つ。ここがやるのは
    ①要求の形を見る ②Origin ヘッダを渡す ③**null を 403 に翻訳する**、の3つだけ。
  🔴 **fail-closed**: 設定が引けない・上流が落ちた・許可されていない —— どの場合も
    **CORS のヘッダを1つも付けない**。埋め込みスクリプト側は取得に失敗した扱いになり、
    **ポップが出ないだけで LP は無傷**(要件書 §5-2)。
*/
import { NextResponse } from "next/server";
import {
  corsHeaders,
  NO_STORE,
  originProblem,
  siteKeyProblem,
} from "@/lib/api/http";
import { callRpc, RPC } from "@/lib/db/rpc";

/** ⚠ 認可の結果を返すので、静的化も ISR もしない。 */
export const dynamic = "force-dynamic";

/** 0003 の `adpop_site_config` が返す形。⚠ **正はマイグレーション側**(ここは写し)。 */
type SiteConfig = Record<string, unknown> | null;

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

  const result = await callRpc<SiteConfig>(RPC.siteConfig, {
    p_site_key: siteKey,
    p_origin: origin,
  });

  if (!result.ok) {
    /*
      🔴 **握り潰さない。** 「設定を書き忘れた」と「許可ドメインを外した」は
        どちらも訪問者からは「ポップが出ない」に見えるので、**サーバーのログにだけは残す**
        (要件書 §5-2「握り潰して誰も見ない」は繰り返す欠陥の型)。
      ⚠ 管理画面に届ける仕組みは PR3。**いまはログまで**、と書いておく。
    */
    console.error(`[adpop] config rpc failed (${result.kind}): ${result.detail}`);
    return deny(result.kind === "config" ? 503 : 502, result.kind);
  }

  // 🔴 null = サイトが無い / Origin が許可されていない / active なポップが無い。**区別しない。**
  if (result.data === null) return deny(403, "not_allowed");

  return NextResponse.json(result.data, {
    status: 200,
    headers: { ...corsHeaders(origin as string), "cache-control": NO_STORE },
  });
}
