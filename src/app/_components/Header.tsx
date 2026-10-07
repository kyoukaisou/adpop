"use client";

/*
  🔴 レビュー指摘: ログアウト失敗を成功扱いしていた(POSTの結果を見ずに必ず/loginへ移動)。
    成功(2xx)か、サーバーが既にセッション無効と言っている(401)ときだけ移動する。それ以外(通信失敗・5xx等)は
    画面に留まりエラーを出す(サーバー側のセッションが残っているのに「ログアウトした」と見せない=P-011)。
  🔴 `onBeforeLeave`(既定なし。設計上の要件): ポップ編集画面で未保存の変更がある間にログアウトを押すと、
    実際にログアウトを送る前に確認する。確認のモーダル自体はページ側が持つ(`LeaveGuard` 参照)ので、
    ここは「渡されたら確認を経由する・渡されなければ今まで通り」だけを知っていればよい。
    他の画面は渡さないので動きは変わらない。
  🔴 レビュー指摘: `doLogout` は「実際にログアウトして遷移できたか」を `boolean` で返す。
    呼び出し側(ページ)が、失敗(= 遷移しなかった)ときに `beforeunload` の抑止を解除できるように
    するため(`LeaveGuard`/`bypassOnce`/`cancelBypass` 参照)。
*/
import { useRef, useState } from "react";
import { postJson } from "../_lib/api";
import type { LeaveGuard } from "../_lib/unsavedChanges";

export function Header({ onBeforeLeave }: { onBeforeLeave?: LeaveGuard }) {
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function doLogout(): Promise<boolean> {
    submittingRef.current = true;
    setError(null);
    const result = await postJson("/logout", {});
    if (result.ok || result.status === 401) {
      window.location.href = "/login";
      return true;
    }
    submittingRef.current = false;
    setError("ログアウトできませんでした。もう一度お試しください。");
    return false;
  }

  function handleLogoutClick() {
    if (submittingRef.current) return;
    if (onBeforeLeave) onBeforeLeave(doLogout);
    else void doLogout();
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
            onClick={handleLogoutClick}
            className="font-mono text-xs text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            ログアウト
          </button>
        </div>
      </div>
    </header>
  );
}
