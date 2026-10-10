/*
  `GuardedLink`(D-384 Codexレビュー指摘4)の判定ロジックだけを切り出した純粋関数。
  このリポジトリはまだReactコンポーネントの描画検査を持たない(vitest.config.mts参照)ため、
  「サイドバー・ドロワー・サイト切替・パンくずのリンクが、全部同じガードを通る」ことを
  DOM抜きでテストできるよう、ここに1本化する。`GuardedLink.tsx` はこれを呼ぶだけにする。
*/
import type { LeaveGuard } from "./unsavedChanges";

export type GuardedClickDecision =
  // onBeforeLeave が無い = 素の <a> の既定のナビゲーションに任せる(preventDefaultしない)
  | { guarded: false }
  // onBeforeLeave がある = preventDefaultした上で、`proceed` を onBeforeLeave に渡す
  | { guarded: true; proceed: () => boolean };

/**
 * @param navigate 実際に遷移を起こす関数(本番では `(href) => { window.location.href = href }`)
 */
export function resolveGuardedClick(href: string, onBeforeLeave: LeaveGuard | undefined, navigate: (href: string) => void): GuardedClickDecision {
  if (!onBeforeLeave) return { guarded: false };
  return {
    guarded: true,
    proceed: () => {
      navigate(href);
      return true; // 常に実際の遷移を起こす(失敗しうるのはログアウトのAPI呼び出しだけ。GuardedLinkは使わない)
    },
  };
}
