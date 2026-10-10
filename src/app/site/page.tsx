"use client";

/*
  互換ページ(D-384 Codexレビュー指摘2)。旧「サイト内」画面(`/site?id=...`)は `/popups?site=...`
  に統合したが、既存のブックマーク・ブラウザ履歴・外部リンクはまだ `/site?id=...` を指しうる。
  静的書き出し(`output: "export"`)はサーバー側のredirect/rewriteを持てないため、
  このページ自体を薄い転送(クライアント側 `window.location.href`)として残す。
  🔴 `id` クエリの名前は変えず、`/popups` 側のクエリ名(`site`)に積み替えるだけ。
*/
import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { legacySiteRedirectTarget } from "../_lib/legacySiteRedirect";

function SiteRedirectContent() {
  const params = useSearchParams();
  const siteId = params.get("id") ?? "";

  useEffect(() => {
    window.location.href = legacySiteRedirectTarget(siteId);
  }, [siteId]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="sr-only">ADPOP</h1>
    </main>
  );
}

export default function SiteRedirectPage() {
  return (
    <Suspense fallback={null}>
      <SiteRedirectContent />
    </Suspense>
  );
}
