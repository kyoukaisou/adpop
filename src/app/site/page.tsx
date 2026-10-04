"use client";

/*
  サイト内・ポップ一覧(画面設計 §3-3)。
  ⚠ 表示/クリック/閉じた の集計値は、管理 API にまだ集計を返すエンドポイントが無い
    (events テーブルはあるが admin.ts に読む関数が無い)。実在しない数字を "0" と見せると
    「0件」に読めてしまう事故になる(§3-3 の成約列の裁定と同じ理由)ので、プレースホルダ「—」を出す。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { deleteJson, getJson, postJson, putJson } from "../_lib/api";
import { ApiPopup, ApiSite, POPUP_LIMIT } from "../_lib/types";
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

function embedTag(siteKey: string): string {
  const origin = DELIVERY_ORIGIN !== "" ? DELIVERY_ORIGIN : "(配信元のURLが未設定)";
  return `<script async src="${origin}/embed/t.js" data-adpop-site="${siteKey}"></script>`;
}

function SiteContent() {
  const sessionState = useRequireSession();
  const params = useSearchParams();
  const siteId = params.get("id") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [popups, setPopups] = useState<ApiPopup[] | null>(null);
  const [loadError, setLoadError] = useState(false);
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
    const [siteResult, popupsResult] = await Promise.all([
      getJson<ApiSite>(`/sites/${siteId}`),
      getJson<ApiPopup[]>(`/sites/${siteId}/popups`),
    ]);
    if (!siteResult.ok || !popupsResult.ok) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setSite(siteResult.data);
    setPopups(popupsResult.data);
  }, [siteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- マウント時に1回だけ取得する意図的な呼び出し(setStateはawaitの後)
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
                <div className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2.5">
                  <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-ink/70">
                    {embedTag(site.siteKey)}
                  </code>
                  <CopyButton text={embedTag(site.siteKey)} label="埋め込みタグをコピー" />
                </div>
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
                        <span>表示 <span className="text-ink">—</span></span>
                        <span>クリック <span className="text-ink">—</span></span>
                        <span>閉じた <span className="text-ink">—</span></span>
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
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink">—</td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink">—</td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink">—</td>
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
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink/60">—</td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink/60">—</td>
                          <td className="px-3 py-3.5 text-right font-mono text-sm text-ink/60">—</td>
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
          stats={null}
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
