"use client";

/*
  離脱ガードを通る `<a>`(D-384 Codexレビュー指摘4)。
  🔴 以前は「パンくず」「ナビ」がそれぞれ別々に同じ分岐(onBeforeLeaveがあれば
  preventDefault→onBeforeLeave経由、無ければ素のリンク)を書いていて、新しく足したリンク
  (サイドバーの「タグの設置」カード・サイト切替の「すべてのサイトを管理」)がこの分岐から漏れ、
  ポップ編集中の未保存確認を通らずに離脱できてしまっていた。
  **ガードの判定ロジックを `resolveGuardedClick`(`_lib/guardedLink.ts`)に1本化**し、`<a>` は
  この `GuardedLink` を経由させる。`<button>` で遷移するサイト切替の候補一覧だけは、この
  コンポーネントの形にできないため `resolveGuardedClick` を直接呼ぶ(`SiteSwitcher.tsx`)。
*/
import type { LeaveGuard } from "../_lib/unsavedChanges";
import { resolveGuardedClick } from "../_lib/guardedLink";

export function GuardedLink({
  href,
  onBeforeLeave,
  onBeforeNavigate,
  className,
  children,
  ...rest
}: {
  href: string;
  onBeforeLeave?: LeaveGuard;
  /** ガードの成否に関わらず、クリックした瞬間に呼ぶ(例: ドロワーを閉じる)。 */
  onBeforeNavigate?: () => void;
  className?: string;
  children: React.ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className" | "children" | "onClick">) {
  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    onBeforeNavigate?.();
    const decision = resolveGuardedClick(href, onBeforeLeave, (target) => {
      window.location.href = target;
    });
    if (!decision.guarded) return; // ガード無し = 素の <a> のまま(既定のナビゲーションに任せる)
    event.preventDefault();
    onBeforeLeave?.(decision.proceed);
  }

  return (
    <a href={href} className={className} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
