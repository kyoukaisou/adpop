"use client";

/*
  サイト一覧(画面設計 §3-2)。
*/
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "../_lib/api";
import { ApiPopup, ApiSite, SITE_LIMIT } from "../_lib/types";
import { Header } from "../_components/Header";
import { Loading } from "../_components/Loading";
import { ErrorBanner } from "../_components/ErrorBanner";
import { EmptyState, SiteIcon } from "../_components/EmptyState";
import { AddSiteModal } from "../_components/AddSiteModal";
import { useRequireSession } from "../_lib/useRequireSession";

type SiteRow = ApiSite & { activePopupName: string | null };

function shortenKey(key: string): string {
  if (key.length <= 10) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export default function SitesPage() {
  const sessionState = useRequireSession();
  const [rows, setRows] = useState<SiteRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    const sitesResult = await getJson<ApiSite[]>("/sites");
    if (!sitesResult.ok) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const sites = sitesResult.data;
    // ⚠ 「稼働中: 名前」の表示には、サイトごとのポップ一覧が要る(listSites は持たない)。
    //   サイト数は最大20件という構造的な天井があるため、ここでは1件ずつ取りに行く。
    const withActive = await Promise.all(
      sites.map(async (site) => {
        const popups = await getJson<ApiPopup[]>(`/sites/${site.id}/popups`);
        const active = popups.ok ? popups.data.find((p) => p.archivedAt === null && p.status === "active") : undefined;
        return { ...site, activePopupName: active?.name ?? null };
      }),
    );
    setRows(withActive);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- マウント時に1回だけ取得する意図的な呼び出し(setStateはawaitの後)
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

  async function handleCreate(input: { name: string; allowedOrigins: string[] }): Promise<string | null> {
    const result = await postJson<{ id: string }>("/sites", input);
    if (!result.ok) {
      if (result.status === 409 && result.reason === "limit") return `サイトは${SITE_LIMIT}件までです`;
      if (result.status === 400) return "入力内容を確認してください";
      return "作成できませんでした。もう一度お試しください。";
    }
    setShowAdd(false);
    await load();
    return null;
  }

  if (sessionState !== "ready") return null;

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[960px] px-6 py-10">
        <div className="mb-6 flex items-end justify-between">
          <h1 className="text-xl font-semibold tracking-tight">サイト</h1>
          <div className="flex items-center gap-4">
            {rows !== null && <span className="font-mono text-xs text-ink/60">{rows.length} / {SITE_LIMIT}</span>}
            {rows !== null && rows.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="h-9 rounded-lg bg-ink px-3.5 text-sm font-semibold text-paper hover:bg-ink/90
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                + サイトを追加
              </button>
            )}
          </div>
        </div>

        {loadError && <ErrorBanner message="サイトを取得できませんでした。もう一度お試しください。" onRetry={load} />}
        {rows === null && !loadError && <Loading label="サイトを読み込み中" />}

        {rows !== null && rows.length === 0 && (
          <EmptyState
            icon={SiteIcon}
            title="まだサイトがありません"
            description="サイトを追加すると、LPに貼る埋め込みタグが発行されます。"
            action={
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="h-10 rounded-lg bg-ink px-4 text-sm font-semibold text-paper hover:bg-ink/90
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                + サイトを追加
              </button>
            }
          />
        )}

        {rows !== null && rows.length > 0 && (
          <div className="rounded-xl border border-line bg-surface divide-y divide-line">
            {rows.map((site) => (
              <a
                key={site.id}
                href={`/site?id=${site.id}`}
                className="group flex flex-col gap-3 px-5 py-4 hover:bg-paper/70 sm:flex-row sm:items-center sm:justify-between sm:gap-6
                           focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink">{site.name}</div>
                  <div className="mt-1 flex items-center gap-3 font-mono text-xs text-ink/60">
                    <span>キー {shortenKey(site.siteKey)}</span>
                    <span>許可ドメイン {site.allowedOrigins.length}件</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {site.activePopupName !== null ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-soft px-2.5 py-1 text-xs font-semibold text-signal">
                      <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden="true"></span>
                      稼働中: {site.activePopupName}
                    </span>
                  ) : (
                    <span className="text-xs text-ink/60">稼働ポップなし</span>
                  )}
                  <svg className="h-4 w-4 text-ink/60" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M7.5 5l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </a>
            ))}
          </div>
        )}
      </main>

      {showAdd && <AddSiteModal onCancel={() => setShowAdd(false)} onCreate={handleCreate} />}
    </>
  );
}
