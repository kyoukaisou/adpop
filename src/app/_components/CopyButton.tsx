"use client";

/*
  コピー操作ボタン。
  🔴 2026-10-04 の見本修正どおり 44×44px を確保する(旧 03-popups.html の28×28pxは採らない。
    screenshots/2026-10-04-adpop-image/html/08b-empty-popups.html のコメント参照)。
*/
import { useState } from "react";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ⚠ クリップボードAPIが使えない環境。黒子で失敗せず、せめて選択可能なテキストのまま残す
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      onClick={handleClick}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink/60 hover:bg-line/50 hover:text-ink
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      {copied ? (
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5 10.5l3.2 3.2L15.5 6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="6.5" y="6.5" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M13.5 6.5V4.5a1 1 0 00-1-1h-8a1 1 0 00-1 1v8a1 1 0 001 1h2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
      <span className="sr-only" role="status">
        {copied ? "コピーしました" : ""}
      </span>
    </button>
  );
}
