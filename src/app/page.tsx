"use client";

/*
  ルート(D-384)。セッションが無ければ /login。あれば、サイトが0件なら最初のサイト作成のため
  /sites(既存の作成フロー)、1件以上あれば最初のサイトのダッシュボードへ送る
  (静的書き出しなので判定はクライアント側)。
  ⚠ 「最後に見ていたサイト」の記憶は実装していない(スコープ外。常に一覧の先頭に送る)。
*/
import { useEffect } from "react";
import { getJson } from "./_lib/api";
import type { ApiSite } from "./_lib/types";

export default function Home() {
  useEffect(() => {
    getJson("/session").then(async (session) => {
      if (!session.ok) {
        window.location.href = "/login";
        return;
      }
      const sites = await getJson<ApiSite[]>("/sites");
      if (sites.ok && sites.data.length > 0) {
        window.location.href = `/dashboard?site=${sites.data[0].id}`;
      } else {
        window.location.href = "/sites";
      }
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="sr-only">ADPOP</h1>
    </main>
  );
}
