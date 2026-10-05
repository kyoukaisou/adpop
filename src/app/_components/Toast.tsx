"use client";

/*
  保存成功のトースト(画面設計 §7-4)。動詞を固定: ボタンは「保存」、結果は「保存しました」。
  `role="status"` で支援技術にも通知する(視覚だけに頼らない)。
*/
import { useEffect } from "react";

export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 3000);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 z-20 flex items-center gap-2 rounded-lg bg-ink px-4 py-3 text-sm font-medium text-paper shadow-xl"
    >
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M5 10.5l3.2 3.2L15.5 6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {message}
    </div>
  );
}
