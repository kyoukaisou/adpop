"use client";

/*
  左サイドバー(画面設計 §9。拓実さんの参考画像=popflowの骨格に、ADPOPのトークンで組み直したもの)。
  ダッシュボード/ポップ管理/タグの設置 の3項目のみ(§8-3-1で一度不採用にしたサイドバーを
  D-381で採用し直した。LINEハーネスのような20以上のセクションは無いので、この3項目で全部)。

  🔴 発注の裁定1(D-384): 「+ ポップを作成」はダッシュボードから削除した(ポップの作成は
    「ポップ管理」からだけ行う)。このサイドバー自体にも作成ボタンは置かない。
  🔴 「タグの設置」の促しカード(下部)は、いま見ている画面がタグの設置そのものの時は出さない
    (自分がいる場所への誘導を出さない)。
*/
import { useRef, useState } from "react";
import { postJson } from "../_lib/api";
import type { LeaveGuard } from "../_lib/unsavedChanges";
import { GuardedLink } from "./GuardedLink";
import { SiteSwitcher } from "./SiteSwitcher";

export type NavKey = "dashboard" | "popups" | "tags";

const NAV_ITEMS: Array<{ key: NavKey; label: string; href: (siteId: string) => string; icon: React.ReactNode }> = [
  {
    key: "dashboard",
    label: "ダッシュボード",
    href: (siteId) => `/dashboard?site=${siteId}`,
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="11" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="11" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="11" y="11" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    key: "popups",
    label: "ポップ管理",
    href: (siteId) => `/popups?site=${siteId}`,
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 8h8M6 11h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "tags",
    label: "タグの設置",
    href: (siteId) => `/tags?site=${siteId}`,
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M7 6L3 10l4 4M13 6l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

function NavLink({
  item,
  active,
  siteId,
  onBeforeLeave,
  onNavigate,
}: {
  item: (typeof NAV_ITEMS)[number];
  active: boolean;
  siteId: string;
  onBeforeLeave?: LeaveGuard;
  onNavigate?: () => void;
}) {
  const href = item.href(siteId);
  return (
    <GuardedLink
      href={href}
      aria-current={active ? "page" : undefined}
      onBeforeLeave={onBeforeLeave}
      onBeforeNavigate={onNavigate}
      className={`flex h-11 items-center gap-2.5 rounded-lg px-3.5 text-sm font-semibold
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                  ${active ? "bg-ink text-paper" : "text-ink/70 hover:bg-paper"}`}
    >
      {item.icon}
      {item.label}
    </GuardedLink>
  );
}

// 🔴 D-384 Codexレビュー指摘4: このリンクが `onBeforeLeave` を受け取らず素の `<a>` のままだったため、
//   ポップ編集中の未保存確認を通らずに離脱できてしまっていた。`GuardedLink` 経由にする。
function TagPromoCard({ siteId, onBeforeLeave, onNavigate }: { siteId: string; onBeforeLeave?: LeaveGuard; onNavigate?: () => void }) {
  return (
    <GuardedLink
      href={`/tags?site=${siteId}`}
      onBeforeLeave={onBeforeLeave}
      onBeforeNavigate={onNavigate}
      className="mb-4 block rounded-xl border border-line bg-paper p-4 hover:bg-paper/70
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M7 6L3 10l4 4M13 6l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        タグの設置
      </div>
      <p className="text-xs leading-relaxed text-ink/60">埋め込みタグをLPに貼ると、このサイトでポップの配信が始まります。</p>
      <div className="mt-2.5 text-xs font-semibold text-ink underline underline-offset-2">タグの設置を見る</div>
    </GuardedLink>
  );
}

function AccountMenu({ onBeforeLeave }: { onBeforeLeave?: LeaveGuard }) {
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function doLogout(): Promise<boolean> {
    submittingRef.current = true;
    setError(null);
    const result = await postJson("/logout", {});
    if (result.ok || result.status === 401) {
      window.location.href = "/login";
      return true;
    }
    submittingRef.current = false;
    setError("ログアウトできませんでした。もう一度お試しください。");
    return false;
  }

  function handleClick() {
    if (submittingRef.current) return;
    if (onBeforeLeave) onBeforeLeave(doLogout);
    else void doLogout();
  }

  return (
    <div className="border-t border-line pt-4">
      {error && (
        <p role="alert" className="mb-2 text-xs font-medium text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper text-xs font-semibold text-ink/60" aria-hidden="true">
          A
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">管理者</div>
          <button
            type="button"
            onClick={handleClick}
            className="text-xs text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            ログアウト
          </button>
        </div>
      </div>
    </div>
  );
}

export function SidebarContent({
  activeNav,
  siteId,
  currentSiteName,
  onAddSite,
  onBeforeLeave,
  onNavigate,
}: {
  activeNav: NavKey;
  siteId: string;
  currentSiteName: string;
  onAddSite: () => void;
  onBeforeLeave?: LeaveGuard;
  /** ドロワーでリンクを押したあとに閉じるためのコールバック(デスクトップ版では渡さない)。 */
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex items-center gap-2">
        <span className="inline-block h-5 w-5 rounded-md bg-ink" aria-hidden="true"></span>
        <span className="text-sm font-semibold tracking-tight">ADPOP</span>
      </div>

      {/*
        🔴 サイトの切り替え(申し送り1: 開いた状態は未設計 → 既存部品で最小の形)。
        `SiteSwitcher` 自身が `GET /sites` を読む(ここで二重に読まない)。
      */}
      <SiteSwitcher siteId={siteId} currentSiteName={currentSiteName} onAddSite={onAddSite} onBeforeLeave={onBeforeLeave} />

      <nav aria-label="メインメニュー" className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            item={item}
            active={item.key === activeNav}
            siteId={siteId}
            onBeforeLeave={onBeforeLeave}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="flex-1" />

      {activeNav !== "tags" && <TagPromoCard siteId={siteId} onBeforeLeave={onBeforeLeave} onNavigate={onNavigate} />}
      <AccountMenu onBeforeLeave={onBeforeLeave} />
    </div>
  );
}
