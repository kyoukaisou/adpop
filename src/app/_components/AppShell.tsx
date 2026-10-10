"use client";

/*
  全体構成(画面設計 §9・D-384): 左サイドバー + パンくず + 390pxのハンバーガー/ドロワー。
  サイト一覧・ポップ一覧・ポップ編集(§3)はこの中の `children` としてそのまま載せ替える。
*/
import { useState } from "react";
import { Breadcrumb } from "./Breadcrumb";
import { Drawer } from "./Drawer";
import { SidebarContent, type NavKey } from "./Sidebar";
import type { LeaveGuard } from "../_lib/unsavedChanges";

export function AppShell({
  activeNav,
  siteId,
  currentSiteName,
  breadcrumbItems,
  onAddSite,
  onBeforeLeave,
  children,
}: {
  activeNav: NavKey;
  siteId: string;
  currentSiteName: string;
  breadcrumbItems: Array<{ label: string; href?: string }>;
  onAddSite: () => void;
  onBeforeLeave?: LeaveGuard;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-screen sm:flex">
      {/* デスクトップ: 常設のサイドバー */}
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface p-5 sm:flex sm:flex-col" aria-label="サイドバー">
        <SidebarContent
          activeNav={activeNav}
          siteId={siteId}
          currentSiteName={currentSiteName}
          onAddSite={onAddSite}
          onBeforeLeave={onBeforeLeave}
        />
      </aside>

      {/* 390px: ハンバーガー + ドロワー */}
      <div className="flex h-14 items-center justify-between border-b border-line bg-surface px-4 sm:hidden">
        <div className="flex items-center gap-2">
          <span className="inline-block h-5 w-5 rounded-md bg-ink" aria-hidden="true"></span>
          <span className="text-sm font-semibold tracking-tight">ADPOP</span>
        </div>
        <button
          type="button"
          aria-label="メニューを開く"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-ink/70 hover:bg-paper
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {drawerOpen && (
        <Drawer titleId="adpop-drawer-title" onClose={() => setDrawerOpen(false)}>
          <div className="mb-4 flex items-center justify-between">
            <span id="adpop-drawer-title" className="text-sm font-semibold tracking-tight">
              ADPOP
            </span>
            <button
              type="button"
              aria-label="メニューを閉じる"
              onClick={() => setDrawerOpen(false)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-ink/70 hover:bg-paper
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <SidebarContent
            activeNav={activeNav}
            siteId={siteId}
            currentSiteName={currentSiteName}
            onAddSite={() => {
              setDrawerOpen(false);
              onAddSite();
            }}
            onBeforeLeave={onBeforeLeave}
            onNavigate={() => setDrawerOpen(false)}
          />
        </Drawer>
      )}

      <main className="min-w-0 flex-1 px-5 py-8 sm:px-10 sm:py-10">
        <div className="mx-auto max-w-[1040px]">
          <Breadcrumb items={breadcrumbItems} onBeforeLeave={onBeforeLeave} />
          {children}
        </div>
      </main>
    </div>
  );
}
