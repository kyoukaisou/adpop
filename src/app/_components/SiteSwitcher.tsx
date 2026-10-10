"use client";

/*
  サイトの切り替え(画面設計 §9・エンジニアへの申し送り1「開いた状態は未設計」)。
  🔴 発注の裁定どおり、開いた状態(一覧)は**既存の部品で最小の形**にした: サイト名の一覧
    (`GET /sites` をそのまま読む)+「+ サイトを追加」(既存の `AddSiteModal` を呼ぶ)だけ。
    承認済み見本(2026-10-10)には開いた状態の絵が無いため、この部分は見本と**違う形**になる
    (PRにスクリーンショットを添付する)。
  ⚠ 取得の失敗と0件を混同しない(P-011): `sites` が `null` の間は「読み込み中」、
    `loadError` が true なら「取得できませんでした」(0件とは言わない)。
*/
import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { getJson } from "../_lib/api";
import type { ApiSite } from "../_lib/types";
import type { LeaveGuard } from "../_lib/unsavedChanges";

export function SiteSwitcher({
  siteId,
  currentSiteName,
  onAddSite,
  onBeforeLeave,
}: {
  siteId: string;
  currentSiteName: string;
  onAddSite: () => void;
  onBeforeLeave?: LeaveGuard;
}) {
  const labelId = useId();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<ApiSite[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    getJson<ApiSite[]>("/sites").then((res) => {
      if (!active) return;
      if (res.ok) {
        setSites(res.data);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // 🔴 セルフレビューで発見: Escで閉じる導線が無かった(キーボード操作でリストボックスを
  //   開いたまま抜けられない)。閉じた上で、トリガーのボタンへフォーカスを戻す(見失わせない)。
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function navigate(targetSiteId: string) {
    const href = `${pathname}?site=${targetSiteId}`;
    const go = () => {
      window.location.href = href;
      return true;
    };
    setOpen(false);
    if (onBeforeLeave) onBeforeLeave(go);
    else go();
  }

  return (
    <div ref={containerRef} className="relative mb-4">
      <span id={labelId} className="mb-1.5 block text-xs font-medium text-ink/60">
        サイト
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${labelId}-value`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-line bg-paper px-3.5
                   text-sm font-semibold text-ink hover:bg-paper/70
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span id={`${labelId}-value`} className="truncate">
          {currentSiteName}
        </span>
        <svg className="h-4 w-4 shrink-0 text-ink/60" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="サイトを選ぶ"
          className="absolute z-30 mt-1.5 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-lg"
        >
          {loadError && <div className="px-2.5 py-2 text-xs font-medium text-danger">サイトを取得できませんでした</div>}
          {sites === null && !loadError && <div className="px-2.5 py-2 text-xs text-ink/60">読み込み中…</div>}
          {sites !== null &&
            sites.map((site) => (
              <button
                key={site.id}
                type="button"
                role="option"
                aria-selected={site.id === siteId}
                onClick={() => navigate(site.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm
                            hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                            ${site.id === siteId ? "font-semibold text-ink" : "text-ink/70"}`}
              >
                <span className="truncate">{site.name}</span>
                {site.id === siteId && (
                  <svg className="h-4 w-4 shrink-0 text-ink" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 10.5l3.2 3.2L15.5 6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))}
          <div className="my-1.5 border-t border-line" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onAddSite();
            }}
            className="block w-full rounded-md px-2.5 py-2 text-left text-sm font-medium text-ink hover:bg-paper
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            + サイトを追加
          </button>
          <a
            href="/sites"
            className="block rounded-md px-2.5 py-2 text-left text-sm text-ink/60 hover:bg-paper hover:text-ink
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            すべてのサイトを管理
          </a>
        </div>
      )}
    </div>
  );
}
