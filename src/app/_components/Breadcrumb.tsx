"use client";

/*
  🔴 `onBeforeLeave`(既定なし。設計上の要件): ポップ編集画面で未保存の変更がある間にパンくずのリンクを
    押すと、実際に移動する前に確認する。渡されたときだけ `<a>` の既定のナビゲーションを止め、
    `onBeforeLeave` に「実際に移動する関数」を渡す(確認のモーダル自体はページ側が持つ)。
    渡されなければ `onClick` 自体を付けない(他の画面は今までどおり素の `<a>`)。
*/
import type { LeaveGuard } from "../_lib/unsavedChanges";

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
            <a
              href={item.href}
              onClick={
                onBeforeLeave
                  ? (event) => {
                      event.preventDefault();
                      const href = item.href as string;
                      onBeforeLeave(() => {
                        window.location.href = href;
                        return true; // 常に実際の遷移を起こす(失敗しうるのはログアウトのAPI呼び出しだけ)
                      });
                    }
                  : undefined
              }
              className="hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {item.label}
            </a>
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
