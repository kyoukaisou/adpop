"use client";

/*
  ポップ編集(画面設計 §3-4)。設定(名前・出すきっかけ・頻度)+ パターン(バリアント)。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiResult, getJson, postJson, putJson } from "../_lib/api";
import { ApiPopup, ApiSite, ApiTrigger, ApiTriggerKind, ApiVariant, VARIANT_LIMIT, deliverableVariantId } from "../_lib/types";
import { Header } from "../_components/Header";
import { Breadcrumb } from "../_components/Breadcrumb";
import { Loading } from "../_components/Loading";
import { ErrorBanner, FieldError } from "../_components/ErrorBanner";
import { Toast } from "../_components/Toast";
import { VariantCard } from "../_components/VariantCard";
import { useRequireSession } from "../_lib/useRequireSession";
import { TAP_TARGET_44_V } from "../_lib/a11y";

/**
 * Codex 1巡目 Should fix: パターンのアーカイブAPIの結果を捨てていた(常に成功扱いで再読み込み)。
 * 401・404・409 を個別に扱う。409 は並行PR(#8)で「稼働中のポップには、配信できるパターンが
 * 1つ以上必要です。先に停止してください」が返るようになる想定で、その文言をそのまま出せるようにしておく。
 */
function variantActionErrorMessage(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  if (result.status === 401) return "セッションが切れました。再度ログインしてください。";
  if (result.status === 404) return "見つかりませんでした。画面を再読み込みしてください。";
  // 🔴 #8 が返す値(src/admin/app.ts fromResult)。サーバーが message を一緒に返すのでそのまま出す
  //   (「稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください」)。
  if (result.status === 409 && (result.reason === "last_deliverable_variant" || result.reason === "no_deliverable_variant")) {
    return result.message ?? "稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください";
  }
  return "操作できませんでした。もう一度お試しください。";
}

const TRIGGER_ORDER: ApiTriggerKind[] = ["exit_intent", "back", "scroll", "idle", "dwell", "visibility"];
const TRIGGER_LABELS: Record<ApiTriggerKind, string> = {
  exit_intent: "画面外への退出(exit intent)",
  back: "戻るボタン",
  scroll: "スクロール到達率",
  idle: "無操作",
  dwell: "滞在時間",
  visibility: "タブ切替",
};

function triggerSubtitle(trigger: ApiTrigger): string | null {
  if (trigger.kind === "exit_intent") return "PCのみ";
  if (trigger.kind === "scroll" && trigger.threshold !== null) return `既定 ${trigger.threshold}%`;
  if ((trigger.kind === "idle" || trigger.kind === "dwell") && trigger.threshold !== null) return `既定 ${trigger.threshold}秒`;
  return null;
}

type Frequency = { suppressDays: string; sessionImpressions: string; postConversionDays: string; minDisplayDelaySeconds: string };

function toFrequency(popup: ApiPopup): Frequency {
  return {
    suppressDays: String(popup.suppressDays),
    sessionImpressions: String(popup.sessionImpressions),
    postConversionDays: String(popup.postConversionDays),
    minDisplayDelaySeconds: String(popup.minDisplayDelaySeconds),
  };
}

function PopupContent() {
  const sessionState = useRequireSession();
  const params = useSearchParams();
  const popupId = params.get("id") ?? "";

  const [site, setSite] = useState<ApiSite | null>(null);
  const [popup, setPopup] = useState<ApiPopup | null>(null);
  const [triggers, setTriggers] = useState<ApiTrigger[] | null>(null);
  const [variants, setVariants] = useState<ApiVariant[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [name, setName] = useState("");
  const [frequency, setFrequency] = useState<Frequency | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [draftKeys, setDraftKeys] = useState<string[]>([]);
  const [variantActionError, setVariantActionError] = useState<string | null>(null);
  const archiveInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (popupId === "") return;
    const popupResult = await getJson<{ popup: ApiPopup; triggers: ApiTrigger[]; variants: ApiVariant[] }>(`/popups/${popupId}`);
    if (!popupResult.ok) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const { popup: p, triggers: t, variants: v } = popupResult.data;
    const siteResult = await getJson<ApiSite>(`/sites/${p.siteId}`);
    setPopup(p);
    setTriggers(t);
    setVariants(v);
    setName(p.name);
    setFrequency(toFrequency(p));
    if (siteResult.ok) setSite(siteResult.data);
  }, [popupId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- マウント時に1回だけ取得する意図的な呼び出し(setStateはawaitの後)
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

  async function saveSettings() {
    if (popup === null || frequency === null) return;
    setSettingsError(null);

    const numbers = {
      suppressDays: Number(frequency.suppressDays),
      sessionImpressions: Number(frequency.sessionImpressions),
      postConversionDays: Number(frequency.postConversionDays),
      minDisplayDelaySeconds: Number(frequency.minDisplayDelaySeconds),
    };
    if (
      !Number.isInteger(numbers.suppressDays) || numbers.suppressDays < 0 ||
      !Number.isInteger(numbers.sessionImpressions) || numbers.sessionImpressions < 1 ||
      !Number.isInteger(numbers.postConversionDays) || numbers.postConversionDays < 0 ||
      !Number.isInteger(numbers.minDisplayDelaySeconds) || numbers.minDisplayDelaySeconds < 0
    ) {
      setSettingsError("頻度の入力内容を確認してください(0以上の整数)。");
      return;
    }
    if (name.trim() === "") {
      setSettingsError("名前を入力してください。");
      return;
    }

    setSettingsSaving(true);
    const nameChanged = name.trim() !== popup.name;
    const nameResult = nameChanged ? await putJson<null>(`/popups/${popupId}/name`, { name: name.trim() }) : { ok: true as const, data: null };
    if (!nameResult.ok) {
      setSettingsSaving(false);
      setSettingsError("保存できませんでした。もう一度お試しください。");
      return;
    }
    const freqResult = await putJson<null>(`/popups/${popupId}/frequency`, numbers);
    setSettingsSaving(false);
    if (!freqResult.ok) {
      setSettingsError("保存できませんでした。もう一度お試しください。");
      return;
    }
    setToast("変更を保存しました");
    await load();
  }

  async function handleToggleExitIntent(current: ApiTrigger) {
    setTriggerError(null);
    const result = await putJson<null>(`/popups/${popupId}/triggers/exit_intent`, { enabled: !current.enabled });
    if (!result.ok) {
      setTriggerError("切り替えられませんでした。もう一度お試しください。");
      return;
    }
    await load();
  }

  if (sessionState !== "ready") return null;
  if (popupId === "") return <ErrorBanner message="ポップが指定されていません。" />;

  if (loadError) {
    return (
      <>
        <Header />
        <main className="mx-auto max-w-[960px] px-6 py-10">
          <ErrorBanner message="ポップを取得できませんでした。もう一度お試しください。" onRetry={load} retryLabel="再読み込み" />
        </main>
      </>
    );
  }

  if (popup === null || triggers === null || variants === null || frequency === null) {
    return (
      <>
        <Header />
        <main className="mx-auto max-w-[960px] px-6 py-10">
          <Loading label="ポップを読み込み中" />
        </main>
      </>
    );
  }

  const activeVariants = variants.filter((v) => v.archivedAt === null);
  const deliverableId = deliverableVariantId(activeVariants);
  const remainingSlots = Math.max(0, VARIANT_LIMIT - activeVariants.length - draftKeys.length);
  const orderedTriggers = TRIGGER_ORDER.map((kind) => triggers.find((t) => t.kind === kind)).filter(
    (t): t is ApiTrigger => t !== undefined,
  );

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[960px] px-6 py-10">
        <Breadcrumb
          items={[
            { label: "サイト", href: "/sites" },
            { label: site?.name ?? "", href: site ? `/site?id=${site.id}` : undefined },
            { label: popup.name },
          ]}
        />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveSettings();
          }}
        >
          <section className="mb-8 rounded-xl border border-line bg-surface p-6">
            <div className="mb-6 flex items-start justify-between">
              <h1 className="text-xl font-semibold tracking-tight">ポップ設定</h1>
              <button
                type="submit"
                disabled={settingsSaving}
                className="h-9 rounded-lg bg-ink px-4 text-sm font-semibold text-paper hover:bg-ink/90
                           disabled:cursor-not-allowed disabled:bg-ink/60
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {settingsSaving ? "保存中…" : "保存"}
              </button>
            </div>

            {settingsError && (
              <div className="mb-6">
                <ErrorBanner message={settingsError} onRetry={saveSettings} retryLabel="もう一度保存" />
              </div>
            )}

            <div className="mb-8 max-w-sm">
              <label htmlFor="popup-name" className="mb-1.5 block text-sm font-medium text-ink">
                ポップ名
              </label>
              <input
                id="popup-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
            </div>

            <div className="mb-8">
              <h2 className="mb-3 text-sm font-semibold text-ink">出すきっかけ</h2>
              {triggerError && <div className="mb-3"><FieldError id="trigger-error" message={triggerError} /></div>}
              <div className="rounded-lg border border-line divide-y divide-line">
                {orderedTriggers.map((trigger) => (
                  <div key={trigger.kind} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className={`text-sm font-medium ${trigger.kind === "exit_intent" ? "text-ink" : "text-ink/60"}`}>
                        {TRIGGER_LABELS[trigger.kind]}
                      </div>
                      {triggerSubtitle(trigger) && (
                        <div className="mt-0.5 font-mono text-xs text-ink/60">{triggerSubtitle(trigger)}</div>
                      )}
                    </div>
                    {trigger.kind === "exit_intent" ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={trigger.enabled}
                        aria-label={`${TRIGGER_LABELS[trigger.kind]}を有効にする`}
                        onClick={() => handleToggleExitIntent(trigger)}
                        className={`h-6 w-11 shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44_V} ${
                          trigger.enabled ? "bg-ink" : "bg-line"
                        }`}
                      >
                        <span
                          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-paper transition-transform motion-reduce:transition-none ${
                            trigger.enabled ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    ) : (
                      <span className="rounded-full bg-paper px-2.5 py-1 text-xs font-medium text-ink/60">準備中</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold text-ink">頻度</h2>
              <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 max-w-xl">
                <div>
                  <label htmlFor="suppress-days" className="mb-1.5 block text-sm font-medium text-ink">
                    再表示しない日数
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="suppress-days"
                      type="number"
                      min={0}
                      value={frequency.suppressDays}
                      onChange={(e) => setFrequency({ ...frequency, suppressDays: e.target.value })}
                      className="w-24 rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink font-mono
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    />
                    <span className="text-sm text-ink/60">日</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="session-impressions" className="mb-1.5 block text-sm font-medium text-ink">
                    セッション内の表示回数
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="session-impressions"
                      type="number"
                      min={1}
                      value={frequency.sessionImpressions}
                      onChange={(e) => setFrequency({ ...frequency, sessionImpressions: e.target.value })}
                      className="w-24 rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink font-mono
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    />
                    <span className="text-sm text-ink/60">回</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="post-conversion-days" className="mb-1.5 block text-sm font-medium text-ink">
                    CV後は表示しない期間
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="post-conversion-days"
                      type="number"
                      min={0}
                      value={frequency.postConversionDays}
                      onChange={(e) => setFrequency({ ...frequency, postConversionDays: e.target.value })}
                      className="w-24 rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink font-mono
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    />
                    <span className="text-sm text-ink/60">日</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="min-delay" className="mb-1.5 block text-sm font-medium text-ink">
                    最短表示待ち
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="min-delay"
                      type="number"
                      min={0}
                      value={frequency.minDisplayDelaySeconds}
                      onChange={(e) => setFrequency({ ...frequency, minDisplayDelaySeconds: e.target.value })}
                      className="w-24 rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink font-mono
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    />
                    <span className="text-sm text-ink/60">秒</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="per-page" className="mb-1.5 block text-sm font-medium text-ink/60">
                    1ページあたりの表示
                  </label>
                  <input
                    id="per-page"
                    type="text"
                    value="1回(固定)"
                    disabled
                    className="w-32 rounded-lg border border-line bg-paper px-3.5 h-10 text-sm text-ink/35 font-mono"
                  />
                </div>
              </div>
            </div>
          </section>
        </form>

        <section>
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-base font-semibold tracking-tight">パターン</h2>
            <span className="font-mono text-xs text-ink/60">
              {activeVariants.length} / {VARIANT_LIMIT}
            </span>
          </div>

          {variantActionError && (
            <div className="mb-4">
              <ErrorBanner message={variantActionError} />
            </div>
          )}

          <div className="space-y-4">
            {activeVariants.map((variant) => (
              <VariantCard
                key={variant.id}
                variant={variant}
                isDeliverable={variant.id === deliverableId}
                popupId={popupId}
                onSaved={async (opts) => {
                  await load();
                  if (opts?.errorMessage) setVariantActionError(opts.errorMessage);
                  else if (!opts?.silent) setToast("変更を保存しました");
                }}
                onArchived={async () => {
                  if (archiveInFlightRef.current) return;
                  archiveInFlightRef.current = true;
                  setVariantActionError(null);
                  const result = await postJson<null>(`/variants/${variant.id}/archive`, {});
                  archiveInFlightRef.current = false;
                  if (!result.ok) {
                    setVariantActionError(variantActionErrorMessage(result));
                    return;
                  }
                  await load();
                }}
                onCancelDraft={null}
              />
            ))}

            {draftKeys.map((key) => (
              <VariantCard
                key={key}
                variant={null}
                isDeliverable={false}
                popupId={popupId}
                onSaved={async (opts) => {
                  setDraftKeys((keys) => keys.filter((k) => k !== key));
                  await load();
                  if (opts?.errorMessage) setVariantActionError(opts.errorMessage);
                  else if (!opts?.silent) setToast("変更を保存しました");
                }}
                onArchived={null}
                onCancelDraft={() => setDraftKeys((keys) => keys.filter((k) => k !== key))}
              />
            ))}

            {Array.from({ length: remainingSlots }).map((_, i) => (
              <button
                key={`add-${i}`}
                type="button"
                onClick={() => setDraftKeys((keys) => [...keys, `draft-${Date.now()}-${i}-${Math.random()}`])}
                className="flex w-full items-center justify-center rounded-xl border border-dashed border-line py-6 text-sm font-medium text-ink/60 hover:border-ink/30 hover:text-ink/60
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                + パターンを追加
              </button>
            ))}
          </div>
        </section>
      </main>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}

export default function PopupPage() {
  return (
    <Suspense fallback={null}>
      <PopupContent />
    </Suspense>
  );
}
