"use client";

/*
  タグの設置(画面設計 §9-1-4。旧 `/site?id=` が持っていた埋め込みタグ・許可ドメインをここへ集約)。
  🔴 CV計測タグは要件書の任意機能で未実装(ASPの成約は取らない決まり)。「—」ではなく「準備中」
    バッジ+理由の文章にした(§3-3・§9-1-2 と同じ考え方。0件に読めることを避ける)。
  🔴 サイト名・許可ドメインの編集(既存の `EditSiteModal`)は、旧 `/site` 画面から機能をそのまま
    ここへ移した。承認済み見本(04-tag-install)は「+ドメインを追加」のインライン操作に見えるが、
    実装は既存のモーダル(入力検証・上限20件のロジックを持つ)をそのまま使い回す選択をした
    (新しい検証ロジックを増やさない)。見本との差分はPRにスクリーンショットを添付する。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getJson, postJson, putJson } from "../_lib/api";
import type { ApiSite } from "../_lib/types";
import { AppShell } from "../_components/AppShell";
import { Loading } from "../_components/Loading";
import { ErrorBanner } from "../_components/ErrorBanner";
import { CopyButton } from "../_components/CopyButton";
import { AddSiteModal, EditSiteModal } from "../_components/AddSiteModal";
import { useRequireSession } from "../_lib/useRequireSession";
import { TAP_TARGET_44 } from "../_lib/a11y";
import { DELIVERY_ORIGIN } from "../_lib/delivery";
import { nextLoadErrorState } from "../_lib/pageLoad";

/** 配信元が未設定なら壊れたタグを見せない(旧 `/site` と同じ判定)。 */
function embedTag(siteKey: string): string | null {
  if (DELIVERY_ORIGIN === "") return null;
  return `<script async src="${DELIVERY_ORIGIN}/embed/t.js" data-adpop-site="${siteKey}"></script>`;
}

function TagsContent() {
  const sessionState = useRequireSession();
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const loadedOnceRef = useRef(false);
  const [showEditSite, setShowEditSite] = useState(false);
  const [showAddSite, setShowAddSite] = useState(false);

  const load = useCallback(async () => {
    if (siteId === "") return;
    const result = await getJson<ApiSite>(`/sites/${siteId}`);
    const next = nextLoadErrorState(result.ok, loadedOnceRef.current);
    setLoadError(next.loadError);
    setReloadError(next.reloadError);
    if (result.ok) {
      loadedOnceRef.current = true;
      setSite(result.data);
    }
  }, [siteId]);

  useEffect(() => {
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

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

  async function handleCreateSite(input: { name: string; allowedOrigins: string[] }): Promise<string | null> {
    const result = await postJson<{ id: string }>("/sites", input);
    if (!result.ok) {
      if (result.status === 409 && result.reason === "limit") return "サイトの上限に達しています";
      if (result.status === 400) return "入力内容を確認してください";
      return "作成できませんでした。もう一度お試しください。";
    }
    window.location.href = `/tags?site=${result.data.id}`;
    return null;
  }

  if (sessionState !== "ready") return null;
  if (siteId === "") return <ErrorBanner message="サイトが指定されていません。" />;

  return (
    <>
      <AppShell
        activeNav="tags"
        siteId={siteId}
        currentSiteName={site?.name ?? ""}
        breadcrumbItems={[{ label: site?.name ?? "", href: `/dashboard?site=${siteId}` }, { label: "タグの設置" }]}
        onAddSite={() => setShowAddSite(true)}
      >
        {loadError && <ErrorBanner message="サイトを取得できませんでした。もう一度お試しください。" onRetry={load} retryLabel="再読み込み" />}
        {reloadError && (
          <div className="mb-6">
            <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={load} retryLabel="再読み込み" />
          </div>
        )}
        {site === null && !loadError && <Loading label="サイトを読み込み中" />}

        {site !== null && (
          <>
            <div className="mb-6 flex items-start justify-between">
              <h1 className="text-xl font-semibold tracking-tight">タグの設置</h1>
              <button
                type="button"
                onClick={() => setShowEditSite(true)}
                className={`text-sm font-medium text-ink/60 hover:text-ink
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44}`}
              >
                サイト名・許可ドメインを編集
              </button>
            </div>
            <p className="mb-6 text-sm leading-relaxed text-ink/70">
              このコードをLPの <code className="font-mono text-xs">{"</body>"}</code> の直前に貼り付けると、このサイトのポップが配信されます。配信するポップは「ポップ管理」の「稼働中」で選びます。
            </p>

            <div className="mb-6 rounded-xl border border-line bg-surface p-5">
              <h2 className="mb-2 text-sm font-semibold text-ink">埋め込みタグ</h2>
              {(() => {
                const tag = embedTag(site.siteKey);
                if (tag === null) {
                  return (
                    <div className="rounded-lg border border-dashed border-line bg-paper px-3 py-2.5 text-xs text-ink/60">配信先が未設定です</div>
                  );
                }
                return (
                  <div className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2.5">
                    <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-ink/70">{tag}</code>
                    <CopyButton text={tag} label="埋め込みタグをコピー" />
                  </div>
                );
              })()}
            </div>

            <div className="mb-6 rounded-xl border border-line bg-surface p-5">
              <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-sm font-semibold text-ink">許可ドメイン</h2>
                <button
                  type="button"
                  onClick={() => setShowEditSite(true)}
                  className="w-fit rounded-lg border border-line px-3 h-9 text-xs font-semibold text-ink hover:bg-paper
                             focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  + ドメインを追加
                </button>
              </div>
              <p className="mb-3 text-xs text-ink/60">このタグは、ここに登録したドメインから読み込んだときだけ配信します。</p>
              <div className="flex flex-wrap gap-2">
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

            <div className="rounded-xl border border-dashed border-line bg-surface p-5">
              <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-sm font-semibold text-ink">CV計測タグ</h2>
                <span className="w-fit rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-ink/60">準備中</span>
              </div>
              <p className="text-sm text-ink/60">成約(コンバージョン)を計測するタグはまだ発行できません。ASPの成約データそのものは引き続き取り扱いません。</p>
            </div>
          </>
        )}
      </AppShell>

      {showEditSite && site !== null && (
        <EditSiteModal
          initialName={site.name}
          initialOrigins={site.allowedOrigins}
          onCancel={() => setShowEditSite(false)}
          onSave={handleEditSite}
        />
      )}
      {showAddSite && <AddSiteModal onCancel={() => setShowAddSite(false)} onCreate={handleCreateSite} />}
    </>
  );
}

export default function TagsPage() {
  return (
    <Suspense fallback={null}>
      <TagsContent />
    </Suspense>
  );
}
