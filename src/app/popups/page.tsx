"use client";

/*
  ポップ管理(画面設計 §3-3・§9。旧 `/site?id=` の内容を全体構成(D-384)に載せ替えたもの)。
  🔴 埋め込みタグ・許可ドメインの表示は「タグの設置」(`/tags`)へ移した(§9-1-4)。
    ここには軽い案内帯だけ残す(同じ内容を2箇所に重複させない)。
  🔴 機能・守りは旧 `/site` から変えていない: 未保存確認は無い画面(フォームを持たないため元から
    無い)・削除の2秒待ち(`ConfirmDeleteDialog`)・稼働0件の案内(`shouldShowNoActivePopupNotice`)・
    CSPに影響する変更はしていない。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { deleteJson, getJson, postJson } from "../_lib/api";
import { ApiPopup, ApiSite, POPUP_LIMIT } from "../_lib/types";
import { ApiPopupStatsMap, deleteConfirmStatsText, formatStatCount, nextStatsState } from "../_lib/stats";
import { AppShell } from "../_components/AppShell";
import { Loading } from "../_components/Loading";
import { ErrorBanner } from "../_components/ErrorBanner";
import { EmptyState, PopupIcon } from "../_components/EmptyState";
import { PopupStatusChip } from "../_components/StatusChip";
import { AddPopupModal } from "../_components/AddPopupModal";
import { AddSiteModal } from "../_components/AddSiteModal";
import { ConfirmDeleteDialog } from "../_components/ConfirmDeleteDialog";
import { useRequireSession } from "../_lib/useRequireSession";
import { TAP_TARGET_44 } from "../_lib/a11y";
import { nextLoadErrorState } from "../_lib/pageLoad";
import { shouldShowNoActivePopupNotice } from "../_lib/siteNotice";

function PopupsContent() {
  const sessionState = useRequireSession();
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [popups, setPopups] = useState<ApiPopup[] | null>(null);
  const [stats, setStats] = useState<ApiPopupStatsMap | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const loadedOnceRef = useRef(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [showAddPopup, setShowAddPopup] = useState(false);
  const [showAddSite, setShowAddSite] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiPopup | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const actionInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (siteId === "") return;
    const [siteResult, popupsResult, statsResult] = await Promise.all([
      getJson<ApiSite>(`/sites/${siteId}`),
      getJson<ApiPopup[]>(`/sites/${siteId}/popups`),
      getJson<ApiPopupStatsMap>(`/sites/${siteId}/popups/stats`),
    ]);
    if (!siteResult.ok || !popupsResult.ok) {
      const next = nextLoadErrorState(false, loadedOnceRef.current);
      setLoadError(next.loadError);
      setReloadError(next.reloadError);
      setStats(nextStatsState(siteResult.ok, popupsResult.ok, statsResult));
      return;
    }
    setLoadError(false);
    setReloadError(false);
    loadedOnceRef.current = true;
    setSite(siteResult.data);
    setPopups(popupsResult.data);
    setStats(nextStatsState(siteResult.ok, popupsResult.ok, statsResult));
  }, [siteId]);

  useEffect(() => {
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

  async function handleCreatePopup(name: string): Promise<string | null> {
    const result = await postJson<{ id: string }>(`/sites/${siteId}/popups`, { name });
    if (!result.ok) {
      if (result.status === 409 && result.reason === "limit") return `ポップは${POPUP_LIMIT}件までです`;
      return "作成できませんでした。もう一度お試しください。";
    }
    setShowAddPopup(false);
    await load();
    return null;
  }

  async function handleCreateSite(input: { name: string; allowedOrigins: string[] }): Promise<string | null> {
    const result = await postJson<{ id: string }>("/sites", input);
    if (!result.ok) {
      if (result.status === 409 && result.reason === "limit") return "サイトの上限に達しています";
      if (result.status === 400) return "入力内容を確認してください";
      return "作成できませんでした。もう一度お試しください。";
    }
    window.location.href = `/popups?site=${result.data.id}`;
    return null;
  }

  async function runAction(popupId: string, action: "pause" | "activate" | "archive" | "restore") {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusyId(popupId);
    setActionError(null);
    const result = await postJson<null>(`/popups/${popupId}/${action}`, {});
    actionInFlightRef.current = false;
    setBusyId(null);
    if (!result.ok) {
      if (result.reason === "no_deliverable_variant") {
        setActionError("配信できるパターンがありません。テキストか、画像を設定した画像のパターンを1つ保存してから稼働にしてください。");
      } else {
        setActionError("操作できませんでした。もう一度お試しください。");
      }
      return;
    }
    await load();
  }

  async function handleDelete() {
    if (deleteTarget === null || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusyId(deleteTarget.id);
    const result = await deleteJson<unknown>(`/popups/${deleteTarget.id}`, { confirm: "delete" });
    actionInFlightRef.current = false;
    setBusyId(null);
    setDeleteTarget(null);
    if (!result.ok) {
      setActionError("削除できませんでした。もう一度お試しください。");
      return;
    }
    await load();
  }

  if (sessionState !== "ready") return null;
  if (siteId === "") return <ErrorBanner message="サイトが指定されていません。" />;

  const active = popups?.filter((p) => p.archivedAt === null) ?? [];
  const archived = popups?.filter((p) => p.archivedAt !== null) ?? [];

  return (
    <>
      <AppShell
        activeNav="popups"
        siteId={siteId}
        currentSiteName={site?.name ?? ""}
        breadcrumbItems={[{ label: site?.name ?? "", href: `/dashboard?site=${siteId}` }, { label: "ポップ管理" }]}
        onAddSite={() => setShowAddSite(true)}
      >
        {loadError && (
          <ErrorBanner message="サイトを取得できませんでした。もう一度お試しください。" onRetry={load} retryLabel="再読み込み" />
        )}
        {reloadError && (
          <div className="mb-6">
            <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={load} retryLabel="再読み込み" />
          </div>
        )}
        {site === null && popups === null && !loadError && <Loading label="サイトを読み込み中" />}

        {site !== null && (
          <>
            {/*
              🔴 埋め込みタグ・許可ドメインは「タグの設置」へ移した(§9-1-4)。ここには
              軽い案内帯だけ残す(発注の確認事項4の裁定に沿う。重複させない)。
            */}
            <div className="mb-6 flex flex-col gap-2 rounded-lg border border-line bg-paper px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="inline-flex items-center gap-2 text-sm text-ink/70">
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M7 6L3 10l4 4M13 6l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                埋め込みタグの確認・許可ドメインの変更は「タグの設置」から
              </span>
              <a
                href={`/tags?site=${siteId}`}
                className={`text-sm font-semibold text-ink underline underline-offset-2 hover:text-ink/80
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44}`}
              >
                タグの設置を見る
              </a>
            </div>

            {shouldShowNoActivePopupNotice(popups, reloadError) && (
              <div className="mb-6 rounded-lg border border-dashed border-line bg-paper px-4 py-3 text-xs text-ink/60">
                稼働中のポップがありません。ポップを稼働にすると、タグを貼ったページに表示されます
              </div>
            )}
          </>
        )}

        {actionError && <ErrorBanner message={actionError} />}

        {popups !== null && (
          <>
            <div className="mb-3 flex items-end justify-between">
              <h1 className="text-xl font-semibold tracking-tight">ポップ</h1>
              <div className="flex items-center gap-4">
                <span className="font-mono text-xs text-ink/60">{popups.length} / {POPUP_LIMIT}</span>
                {active.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAddPopup(true)}
                    className="h-9 rounded-lg bg-ink px-3.5 text-sm font-semibold text-paper hover:bg-ink/90
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    + ポップを追加
                  </button>
                )}
              </div>
            </div>

            {active.length === 0 ? (
              <EmptyState
                icon={PopupIcon}
                title="まだポップがありません"
                description="埋め込みタグをLPに貼ったら、ポップを作って配信を始めましょう。"
                action={
                  <button
                    type="button"
                    onClick={() => setShowAddPopup(true)}
                    className="h-10 rounded-lg bg-ink px-4 text-sm font-semibold text-paper hover:bg-ink/90
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    + ポップを追加
                  </button>
                }
              />
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:hidden">
                  {active.map((popup) => (
                    <div key={popup.id} className="rounded-xl border border-line bg-surface p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <PopupStatusChip status={popup.status} />
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
                          <a
                            href={`/popup?id=${popup.id}`}
                            className={`text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44}`}
                          >
                            編集
                          </a>
                          <button
                            type="button"
                            disabled={busyId === popup.id}
                            onClick={() => runAction(popup.id, popup.status === "active" ? "pause" : "activate")}
                            className={`text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44}`}
                          >
                            {popup.status === "active" ? "停止する" : "稼働にする"}
                          </button>
                          <button
                            type="button"
                            disabled={busyId === popup.id}
                            onClick={() => runAction(popup.id, "archive")}
                            className={`text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44}`}
                          >
                            アーカイブ
                          </button>
                        </div>
                      </div>
                      <div className="mb-3 text-sm font-medium text-ink">{popup.name}</div>
                      <div className="flex gap-5 font-mono text-xs text-ink/60">
                        <span>表示 <span className="text-ink">{formatStatCount(stats, popup.id, "sevenDay", "impression")}</span></span>
                        <span>クリック <span className="text-ink">{formatStatCount(stats, popup.id, "sevenDay", "click")}</span></span>
                        <span>閉じた <span className="text-ink">{formatStatCount(stats, popup.id, "sevenDay", "close")}</span></span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-hidden rounded-xl border border-line bg-surface sm:block">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-line text-xs font-medium text-ink/60">
                        <th scope="col" className="px-5 py-3 text-left font-medium">状態</th>
                        <th scope="col" className="px-3 py-3 text-left font-medium">ポップ</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">表示(7日)</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">クリック(7日)</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">閉じた(7日)</th>
                        <th scope="col" className="px-5 py-3 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {active.map((popup) => (
                        <tr key={popup.id}>
                          <td className="px-5 py-3.5">
                            <PopupStatusChip status={popup.status} />
                          </td>
                          <td className="px-3 py-3.5 text-sm font-medium text-ink">{popup.name}</td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink">
                            {formatStatCount(stats, popup.id, "sevenDay", "impression")}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink">
                            {formatStatCount(stats, popup.id, "sevenDay", "click")}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink">
                            {formatStatCount(stats, popup.id, "sevenDay", "close")}
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex justify-end gap-4 text-sm font-medium">
                              <a
                                href={`/popup?id=${popup.id}`}
                                className={`text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44}`}
                              >
                                編集
                              </a>
                              <button
                                type="button"
                                disabled={busyId === popup.id}
                                onClick={() => runAction(popup.id, popup.status === "active" ? "pause" : "activate")}
                                className={`text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44}`}
                              >
                                {popup.status === "active" ? "停止する" : "稼働にする"}
                              </button>
                              <button
                                type="button"
                                disabled={busyId === popup.id}
                                onClick={() => runAction(popup.id, "archive")}
                                className={`text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44}`}
                              >
                                アーカイブ
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {archived.length > 0 && !archivedOpen && (
              <button
                type="button"
                onClick={() => setArchivedOpen(true)}
                className="mt-3 text-xs font-medium text-ink/60 hover:text-ink/70
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                アーカイブ済み({archived.length}件)を表示
              </button>
            )}

            {archived.length > 0 && archivedOpen && (
              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-ink/70">アーカイブ済み({archived.length}件)</h2>
                  <button
                    type="button"
                    onClick={() => setArchivedOpen(false)}
                    className="text-xs font-medium text-ink/60 hover:text-ink
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    隠す
                  </button>
                </div>
                <div className="overflow-hidden rounded-xl border border-line bg-surface">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-line text-xs font-medium text-ink/60">
                        <th scope="col" className="px-5 py-3 text-left font-medium">ポップ</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">表示(累計)</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">クリック(累計)</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">閉じた(累計)</th>
                        <th scope="col" className="px-5 py-3 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {archived.map((popup) => (
                        <tr key={popup.id}>
                          <td className="px-5 py-3.5 text-sm font-medium text-ink/60">{popup.name}</td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink/60">
                            {formatStatCount(stats, popup.id, "lifetime", "impression")}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink/60">
                            {formatStatCount(stats, popup.id, "lifetime", "click")}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink/60">
                            {formatStatCount(stats, popup.id, "lifetime", "close")}
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex justify-end gap-4 text-sm font-medium">
                              <button
                                type="button"
                                disabled={busyId === popup.id}
                                onClick={() => runAction(popup.id, "restore")}
                                className={`text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 ${TAP_TARGET_44}`}
                              >
                                復元
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(popup)}
                                className={`text-danger/80 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44}`}
                              >
                                完全に削除
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </AppShell>

      {showAddPopup && <AddPopupModal onCancel={() => setShowAddPopup(false)} onCreate={handleCreatePopup} />}
      {showAddSite && <AddSiteModal onCancel={() => setShowAddSite(false)} onCreate={handleCreateSite} />}
      {deleteTarget && (
        <ConfirmDeleteDialog
          name={deleteTarget.name}
          stats={deleteConfirmStatsText(stats, deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </>
  );
}

export default function PopupsPage() {
  return (
    <Suspense fallback={null}>
      <PopupsContent />
    </Suspense>
  );
}
