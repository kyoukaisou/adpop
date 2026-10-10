"use client";

/*
  390px のハンバーガーメニューのドロワー(画面設計 §9・エンジニアへの申し送り2)。
  🔴 フォーカストラップ・開く前のフォーカス位置への復帰・Escで閉じる、の3点セットは
    `useFocusTrap`(`Modal.tsx` と共有)。既存のモーダルと同じ規律を適用する。
*/
import { useFocusTrap } from "../_lib/useFocusTrap";

export function Drawer({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useFocusTrap<HTMLDivElement>(true, onClose);

  return (
    <div className="fixed inset-0 z-20 sm:hidden">
      <button type="button" aria-label="メニューを閉じる" onClick={onClose} className="absolute inset-0 bg-ink/40" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-[min(320px,85vw)] flex-col overflow-y-auto bg-surface p-5 shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}
