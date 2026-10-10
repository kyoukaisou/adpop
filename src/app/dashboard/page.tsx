"use client";

/*
  ダッシュボード(画面設計 §9・D-384)。単位は「選んだサイト」(サイト切り替えはサイドバーの上部)。

  🔴 発注の裁定1: 「+ ポップを作成」はこの画面から削除した(承認済み見本=01-dashboard-data-1280.png
    には右上にあるが、ポップの作成は「ポップ管理」の画面からだけ行う)。見本との差分はPR添付のスクショで示す。
  🔴 発注の裁定2: 推移グラフのクリック数は右側の第2軸(`DailyChart` 参照)。
  🔴 タイルの数字・推移グラフは選んだ期間(7/30/90日)に連動する。両方とも同じ
    `GET /sites/:siteId/stats/daily?period=N` を1回読むだけで出す(タイルの合計はその場で合算する。
    §9-3-4 の新規APIがこの発注で作るもの)。
  🔴 コンバージョン数タイルは「—」+「準備中」バッジ(CVタグ自体が未実装。§3-3と同じ理由を踏襲)。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getJson, postJson } from "../_lib/api";
import type { ApiSite } from "../_lib/types";
import {
  DAILY_STATS_PERIODS,
  formatClickThroughRate,
  isDailyStatsPeriod,
  sumDailyStats,
  type DailyStatsPeriod,
  type DailyStatsPoint,
} from "../_lib/stats";
import { AppShell } from "../_components/AppShell";
import { Loading } from "../_components/Loading";
import { ErrorBanner } from "../_components/ErrorBanner";
import { DailyChart } from "../_components/DailyChart";
import { AddSiteModal } from "../_components/AddSiteModal";
import { useRequireSession } from "../_lib/useRequireSession";
import { nextLoadErrorState } from "../_lib/pageLoad";

const PERIOD_LABEL: Record<DailyStatsPeriod, string> = { 7: "過去7日間", 30: "過去30日間", 90: "過去90日間" };

function Tile({ label, value, caption, icon }: { label: string; value: string; caption: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-ink/70">{label}</span>
        <span className="text-ink/40" aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="font-mono text-2xl font-semibold text-ink">{value}</div>
      <div className="mt-1 text-xs text-ink/60">{caption}</div>
    </div>
  );
}

function DashboardContent() {
  const sessionState = useRequireSession();
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const [period, setPeriod] = useState<DailyStatsPeriod>(30);
  const [daily, setDaily] = useState<DailyStatsPoint[] | null>(null);
  const [dailyError, setDailyError] = useState(false);
  const [showAddSite, setShowAddSite] = useState(false);
  const loadedOnceRef = useRef(false);

  const loadSite = useCallback(async () => {
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

  const loadDaily = useCallback(async () => {
    if (siteId === "") return;
    const result = await getJson<DailyStatsPoint[]>(`/sites/${siteId}/stats/daily?period=${period}`);
    setDailyError(!result.ok);
    setDaily(result.ok ? result.data : null);
  }, [siteId, period]);

  /*
    🔴 `react-hooks/set-state-in-effect`: 1本の effect に「読み込み済みの async 関数を2つ `void` で
    呼ぶ」形を置くと、2つ目の呼び出しだけを誤検知した。**確かめたのは次の2パターンだけ**
    (①loadSite→loadDaily の順 ②その逆順)——どちらも後に書いた方だけが引っかかった。
    「3つ以上」「他の形の組み合わせ」は試していないので、ここでの結論は上の2パターンに限る。
    両方とも `getJson` の await の**後**で setState しており、effect 本体で同期的に setState
    してはいない(ルールが本来守りたい形そのもの)。既知の誤検知として1行だけ抑止する
    (ロジック自体は変えない)。
  */
  useEffect(() => {
    if (sessionState !== "ready") return;
    void loadSite();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 誤検知(上のコメント参照)
    void loadDaily();
  }, [sessionState, loadSite, loadDaily]);

  async function handleCreateSite(input: { name: string; allowedOrigins: string[] }): Promise<string | null> {
    const result = await postJson<{ id: string }>("/sites", input);
    if (!result.ok) {
      if (result.status === 409 && result.reason === "limit") return "サイトの上限に達しています";
      if (result.status === 400) return "入力内容を確認してください";
      return "作成できませんでした。もう一度お試しください。";
    }
    window.location.href = `/dashboard?site=${result.data.id}`;
    return null;
  }

  function handlePeriodChange(value: string) {
    const n = Number(value);
    if (isDailyStatsPeriod(n)) setPeriod(n);
  }

  if (sessionState !== "ready") return null;
  if (siteId === "") return <ErrorBanner message="サイトが指定されていません。" />;

  const totals = daily !== null ? sumDailyStats(daily) : null;

  return (
    <>
      <AppShell
        activeNav="dashboard"
        siteId={siteId}
        currentSiteName={site?.name ?? ""}
        breadcrumbItems={[{ label: site?.name ?? "", href: `/dashboard?site=${siteId}` }, { label: "ダッシュボード" }]}
        onAddSite={() => setShowAddSite(true)}
      >
        {loadError && <ErrorBanner message="サイトを取得できませんでした。もう一度お試しください。" onRetry={loadSite} retryLabel="再読み込み" />}
        {reloadError && (
          <div className="mb-6">
            <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={loadSite} retryLabel="再読み込み" />
          </div>
        )}
        {site === null && !loadError && <Loading label="サイトを読み込み中" />}

        {site !== null && (
          <>
            <h1 className="mb-6 text-xl font-semibold tracking-tight">ダッシュボード</h1>

            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold text-ink/70">
                パフォーマンス <span className="font-normal text-ink/60">・UTC</span>
              </h2>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <select
                    aria-label="集計期間"
                    value={period}
                    onChange={(e) => handlePeriodChange(e.target.value)}
                    className="h-11 appearance-none rounded-lg border border-line bg-surface pl-3 pr-8 text-sm font-medium text-ink
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    {DAILY_STATS_PERIODS.map((p) => (
                      <option key={p} value={p}>
                        {PERIOD_LABEL[p]}
                      </option>
                    ))}
                  </select>
                  <svg className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink/60" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <button
                  type="button"
                  aria-label="再読み込み"
                  onClick={loadDaily}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-line text-ink/60 hover:bg-paper
                             focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M4 10a6 6 0 0110.9-3.5M16 10a6 6 0 01-10.9 3.5M14 4v3h-3M6 16v-3h3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {dailyError && (
              <div className="mb-4">
                <ErrorBanner message="数値を取得できませんでした" onRetry={loadDaily} retryLabel="再読み込み" />
              </div>
            )}

            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
              <Tile
                label="表示数"
                value={totals !== null ? totals.impression.toLocaleString("ja-JP") : "—"}
                caption="配信されたポップの回数"
                icon={
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none">
                    <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" stroke="currentColor" strokeWidth="1.4" />
                    <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                }
              />
              <Tile
                label="クリック数"
                value={totals !== null ? totals.click.toLocaleString("ja-JP") : "—"}
                caption="ボタンをクリックした回数"
                icon={
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none">
                    <path d="M7 3l9 6-4 1-1 4-4-11z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  </svg>
                }
              />
              <Tile
                label="クリック率"
                value={totals !== null ? formatClickThroughRate(totals.impression, totals.click) : "—"}
                caption="クリック数 ÷ 表示数"
                icon={
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none">
                    <path d="M3 15l4-5 3 3 6-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                }
              />
              <div className="rounded-xl border border-dashed border-line bg-surface p-5">
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-sm font-medium text-ink/70">コンバージョン数</span>
                  <span className="w-fit rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-ink/60">準備中</span>
                </div>
                <div className="font-mono text-2xl font-semibold text-ink/40">—</div>
                <a
                  href={`/tags?site=${siteId}`}
                  className="mt-1 inline-block text-xs font-medium text-ink/70 underline underline-offset-2 hover:text-ink
                             focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  CV計測タグを設置する
                </a>
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface p-5">
              <h2 className="text-sm font-semibold text-ink">表示数とクリック数の推移</h2>
              <p className="mb-4 text-xs text-ink/60">日別の内訳です。</p>
              {daily === null && !dailyError && <Loading label="数値を読み込み中" />}
              {daily !== null && <DailyChart points={daily} />}
            </div>
          </>
        )}
      </AppShell>

      {showAddSite && <AddSiteModal onCancel={() => setShowAddSite(false)} onCreate={handleCreateSite} />}
    </>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}
