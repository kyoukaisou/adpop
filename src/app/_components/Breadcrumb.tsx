"use client";

/*
  🔴 `onBeforeLeave`(既定なし。設計上の要件): ポップ編集画面で未保存の変更がある間にパンくずのリンクを
    押すと、実際に移動する前に確認する。
  🔴 D-384 Codexレビュー指摘4: このガードの実装(preventDefault→onBeforeLeave経由)は
    `GuardedLink`(`_components/GuardedLink.tsx`)に1本化した。ここで個別に書き直さない。
*/
import type { LeaveGuard } from "../_lib/unsavedChanges";
import { GuardedLink } from "./GuardedLink";

export function Breadcrumb({
  items,
  onBeforeLeave,
}: {
  items: Array<{ label: string; href?: string }>;
  onBeforeLeave?: LeaveGuard;
}) {
  return (
    <nav aria-label="パンくず" className="mb-5 flex items-center gap-1.5 text-sm text-ink/60">
      {items.map((item, i) => (
        <span key={`${item.label}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">/</span>}
          {item.href ? (
            <GuardedLink
              href={item.href}
              onBeforeLeave={onBeforeLeave}
              className="hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {item.label}
            </GuardedLink>
          ) : (
            <span className="text-ink font-medium" aria-current="page">
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
