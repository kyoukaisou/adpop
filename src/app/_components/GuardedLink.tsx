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

  🔴 D-384 Codexレビュー2巡目の指摘: 以前はクリックの種別を問わずガードしていたため、
    ポップ編集中に Command/Ctrl+クリックで新しいタブに開こうとしても、確認モーダルの後に
    **いま開いている編集タブ自体**が移動してしまっていた。主ボタン・修飾キーなしのクリックだけ
    ガードし、それ以外(修飾キー・中クリック等・`target≠_self`・`download`)は `<a>` の
    既定の動作(新しいタブ・ウィンドウで開く等)に任せる(判定は `resolveGuardedClick` に集約)。
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
    const decision = resolveGuardedClick(
      href,
      onBeforeLeave,
      (target) => {
        window.location.href = target;
      },
      {
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        button: event.button,
        target: rest.target,
        hasDownload: rest.download !== undefined,
      },
    );
    onBeforeNavigate?.(); // ガードの成否・特殊クリックかに関わらず呼ぶ(例: ドロワーを閉じる)
    if (!decision.guarded) return; // ガード無し・特殊クリック = 素の <a> のまま(既定のナビゲーションに任せる)
    event.preventDefault();
    onBeforeLeave?.(decision.proceed);
  }

  return (
    <a href={href} className={className} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
