"use client";

/*
  モーダルの土台(role="dialog" aria-modal="true")。
  🔴 画面設計 §5-1 の申し送り: フォーカストラップ・開く前のフォーカス位置への復帰・Esc で閉じる、の3点セット。
    `packages/embed/src/runtime.ts` が離脱ポップ本体に実装している規律と同じものを管理画面にも適用する。
  🔴 D-384: このロジック自体は `useFocusTrap`(`_lib/useFocusTrap.ts`)に切り出した。390pxの新しい
    ドロワー(`Drawer.tsx`)にも同じ規律を適用するための1本化(振る舞いは変えていない)。
*/
import { useFocusTrap } from "../_lib/useFocusTrap";

export function Modal({
  titleId,
  descriptionId,
  onClose,
  children,
}: {
  titleId: string;
  descriptionId?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useFocusTrap<HTMLDivElement>(true, onClose);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-ink/40 px-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-[440px] rounded-xl border border-line bg-surface p-6 shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}
