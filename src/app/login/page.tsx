"use client";

/*
  ログイン(画面設計 §3-1)。単一管理者。メール+パスワードのみ。
*/
import { useState } from "react";
import { postJson } from "../_lib/api";
import { ErrorBanner } from "../_components/ErrorBanner";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await postJson<unknown>("/login", { email, password });
    setSubmitting(false);
    if (result.ok) {
      // 🔴 D-384: どこへ送るかの判定(サイト0件なら/sites・1件以上ならダッシュボード)は
      //   ホーム(`/`)に1本化してある。ここで`/sites`に決め打ちしない。
      window.location.href = "/";
      return;
    }
    if (result.status === 401) {
      setError("メールアドレスまたはパスワードが正しくありません。");
    } else if (result.status === 429) {
      setError("しばらく時間をおいてから、もう一度お試しください。");
    } else {
      setError("ログインできませんでした。もう一度お試しください。");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex items-center gap-2">
          <span className="inline-block h-6 w-6 rounded-md bg-ink" aria-hidden="true"></span>
          <span className="text-base font-semibold tracking-tight">ADPOP</span>
        </div>

        <form className="rounded-xl border border-line bg-surface p-7" onSubmit={handleSubmit}>
          {error && <ErrorBanner message={error} />}
          <div className="mb-5">
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink">
              メールアドレス
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-11 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <div className="mb-6">
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink">
              パスワード
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-11 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="h-11 w-full rounded-lg bg-ink text-sm font-semibold text-paper
                       hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/60
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {submitting ? "ログイン中…" : "ログイン"}
          </button>
        </form>

        <p className="mt-5 text-center font-mono text-xs text-ink/60">adpop-js · self-hosted</p>
      </div>
    </div>
  );
}
