"use client";

import { postJson } from "../_lib/api";

export function Header() {
  async function handleLogout() {
    await postJson("/logout", {});
    window.location.href = "/login";
  }

  return (
    <header className="h-14 border-b border-line bg-surface">
      <div className="mx-auto flex h-full max-w-[960px] items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <span className="inline-block h-5 w-5 rounded-md bg-ink" aria-hidden="true"></span>
          <span className="text-sm font-semibold tracking-tight">ADPOP</span>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="font-mono text-xs text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          ログアウト
        </button>
      </div>
    </header>
  );
}
