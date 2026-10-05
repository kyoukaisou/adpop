"use client";

/*
  サイト内・ポップ一覧(画面設計 §3-3)。
  🔴 表示/クリック/閉じた の集計値は `GET /sites/:siteId/popups/stats`(PR5a)から読む。
    一覧は `sevenDay`、アーカイブ済み・完全削除の確認は `lifetime`(ADPOP-画面設計.md の決め)。
    取得そのものが失敗(通信失敗・500・503)したら `stats` を `null` にし、`formatStatCount`/
    `deleteConfirmStatsText` が「—」を返す(0件と取得失敗を混同しない。P-011)。
    site・popups の取得失敗(loadError/reloadError)とは**別に**扱う——集計が落ちても
    一覧自体は表示できる(集計の列・削除確認の文言だけが「—」になる)。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { deleteJson, getJson, postJson, putJson } from "../_lib/api";
import { ApiPopup, ApiSite, POPUP_LIMIT } from "../_lib/types";
import { ApiPopupStatsMap, deleteConfirmStatsText, formatStatCount } from "../_lib/stats";
import { Header } from "../_components/Header";
import { Breadcrumb } from "../_components/Breadcrumb";
import { Loading } from "../_components/Loading";
import { ErrorBanner } from "../_components/ErrorBanner";
import { EmptyState, PopupIcon } from "../_components/EmptyState";
import { CopyButton } from "../_components/CopyButton";
import { PopupStatusChip } from "../_components/StatusChip";
import { AddPopupModal } from "../_components/AddPopupModal";
import { EditSiteModal } from "../_components/AddSiteModal";
import { ConfirmDeleteDialog } from "../_components/ConfirmDeleteDialog";
import { useRequireSession } from "../_lib/useRequireSession";
import { TAP_TARGET_44 } from "../_lib/a11y";
import { DELIVERY_ORIGIN } from "../_lib/delivery";
import { nextLoadErrorState } from "../_lib/pageLoad";

/**
 * 🔴 Codex 2巡目 Should fix: 配信元が未設定のとき、壊れたURLのタグを表示してコピーまで
 *   できてしまっていた。未設定なら `null` を返し、呼び出し側はタグ自体を組み立てない
 *   (サムネイルの `deliveryImageUrl` と同じ考え方)。
 */
function embedTag(siteKey: string): string | null {
  if (DELIVERY_ORIGIN === "") return null;
  return `<script async src="${DELIVERY_ORIGIN}/embed/t.js" data-adpop-site="${siteKey}"></script>`;
}

function SiteContent() {
  const sessionState = useRequireSession();
  const params = useSearchParams();
  const siteId = params.get("id") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [popups, setPopups] = useState<ApiPopup[] | null>(null);
  // 🔴 集計(表示・クリック・閉じた)は site/popups とは別の fetch。取得できなければ null にし、
  //   一覧自体の表示は妨げない(「APIが終わっている」前提を鵜呑みにせず、画面が読む値ごとに
  //   取得の成否を分けて持つ——§2026-10-04-09 の型と同じ考え方)。
  const [stats, setStats] = useState<ApiPopupStatsMap | null>(null);
  const [loadError, setLoadError] = useState(false);
  // 🔴 Codex 5巡目: 最初の読み込みと、一度表示した後の再取得(各種操作後のload())を区別する。
  //   このページは元々再取得失敗でも一覧を消していなかったが、文言と扱いをポップ編集画面と揃える。
  const [reloadError, setReloadError] = useState(false);
  const loadedOnceRef = useRef(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [showAddPopup, setShowAddPopup] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiPopup | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showEditSite, setShowEditSite] = useState(false);
  // 🔴 Codex 1巡目 Blocker 1: busyId(state)だけでは連打の瞬間に間に合わないことがあるため、
  //   同期的に読める ref で「いま進行中か」を二重に見る(操作系の共通ガード)。
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
      return;
    }
    setLoadError(false);
    setReloadError(false);
    loadedOnceRef.current = true;
    setSite(siteResult.data);
    setPopups(popupsResult.data);
    // 🔴 集計の失敗は一覧自体のエラーにしない。失敗したら null(= 「—」表示)に戻す
    //   (前回の値を残すと、取得できていないのに古い数字が出続ける)。
    setStats(statsResult.ok ? statsResult.data : null);
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

  async function runAction(popupId: string, action: "pause" | "activate" | "archive" | "restore") {
    if (actionInFlightRef.current) return; // 🔴 同期ラッチで二重送信を防ぐ
    actionInFlightRef.current = true;
    setBusyId(popupId);
    setActionError(null);
    const result = await postJson<null>(`/popups/${popupId}/${action}`, {});
    actionInFlightRef.current = false;
    setBusyId(null);
    if (!result.ok) {
      if (result.reason === "no_deliverable_variant") {
        // ⚠ #8 で画像型も「画像を設定済みなら配信できる」側に入った(deliverableVariantSql)。文言を合わせる
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

  async function handleEditSite(input: { name: string; allowedOrigins: string[] }): Promise<string | null> {
    const result = await putJson<null>(`/sites/${siteId}`, input);
    if (!result.ok) {
      if (result.status === 400) return "入力内容を確認してください";
      return "保存できませんでした。もう一度お試しください。";
    }
    setShowEditSite(false);
    await load();
    return null;
  }

  if (sessionState !== "ready") return null;
  if (siteId === "") return <ErrorBanner message="サイトが指定されていません。" />;

  const active = popups?.filter((p) => p.archivedAt === null) ?? [];
  const archived = popups?.filter((p) => p.archivedAt !== null) ?? [];

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[960px] px-6 py-10">
        <Breadcrumb items={[{ label: "サイト", href: "/sites" }, { label: site?.name ?? "" }]} />

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
          <div className="mb-8 rounded-xl border border-line bg-surface p-6">
            <div className="mb-5 flex items-start justify-between">
              <h1 className="text-xl font-semibold tracking-tight">{site.name}</h1>
              <button
                type="button"
                onClick={() => setShowEditSite(true)}
                className={`text-sm font-medium text-ink/60 hover:text-ink
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44}`}
              >
                編集
              </button>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 sm:gap-8">
              <div>
                <div className="mb-1.5 text-xs font-medium text-ink/60">埋め込みタグ</div>
                {(() => {
                  const tag = embedTag(site.siteKey);
                  if (tag === null) {
                    return (
                      <div className="rounded-lg border border-dashed border-line bg-paper px-3 py-2.5 text-xs text-ink/60">
                        配信先が未設定です
                      </div>
                    );
                  }
                  return (
                    <div className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2.5">
                      <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-ink/70">
                        {tag}
                      </code>
                      <CopyButton text={tag} label="埋め込みタグをコピー" />
                    </div>
                  );
                })()}
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-ink/60">許可ドメイン</div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {site.allowedOrigins.length === 0 ? (
                    <span className="text-sm text-ink/60">未設定</span>
                  ) : (
                    site.allowedOrigins.map((origin) => (
                      <span key={origin} className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-xs text-ink/70">
                        {origin}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {actionError && <ErrorBanner message={actionError} />}

        {popups !== null && (
          <>
            <div className="mb-3 flex items-end justify-between">
              <h2 className="text-base font-semibold tracking-tight">ポップ</h2>
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
      </main>

      {showAddPopup && <AddPopupModal onCancel={() => setShowAddPopup(false)} onCreate={handleCreatePopup} />}
      {showEditSite && site !== null && (
        <EditSiteModal
          initialName={site.name}
          initialOrigins={site.allowedOrigins}
          onCancel={() => setShowEditSite(false)}
          onSave={handleEditSite}
        />
      )}
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

export default function SitePage() {
  return (
    <Suspense fallback={null}>
      <SiteContent />
    </Suspense>
  );
}
