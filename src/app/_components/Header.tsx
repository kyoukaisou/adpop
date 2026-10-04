"use client";

/*
  🔴 Codex 1巡目 Should fix: ログアウト失敗を成功扱いしていた(POSTの結果を見ずに必ず/loginへ移動)。
    成功(2xx)か、サーバーが既にセッション無効と言っている(401)ときだけ移動する。それ以外(通信失敗・5xx等)は
    画面に留まりエラーを出す(サーバー側のセッションが残っているのに「ログアウトした」と見せない=P-011)。
*/
import { useRef, useState } from "react";
import { postJson } from "../_lib/api";

export function Header() {
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function handleLogout() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    const result = await postJson("/logout", {});
    if (result.ok || result.status === 401) {
      window.location.href = "/login";
      return;
    }
    submittingRef.current = false;
    setError("ログアウトできませんでした。もう一度お試しください。");
  }

  return (
    <header className="h-14 border-b border-line bg-surface">
      <div className="mx-auto flex h-full max-w-[960px] items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-2">
          <span className="inline-block h-5 w-5 rounded-md bg-ink" aria-hidden="true"></span>
          <span className="text-sm font-semibold tracking-tight">ADPOP</span>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span role="alert" className="text-xs font-medium text-danger">
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="font-mono text-xs text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            ログアウト
          </button>
        </div>
      </div>
    </header>
  );
}
