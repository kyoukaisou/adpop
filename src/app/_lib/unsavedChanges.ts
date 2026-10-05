/*
  ページを離れるときの確認(ポップ編集・本部発注)。
  🔴 未保存の判定そのものはここでは作らない。呼び出し側(popup/page.tsx)が #12 で既にある基準
  (`variantSync.ts` の baseline 比較・`popupSettingsSync.ts` の `isPopupSettingsDirty`)を使って
  `hasUnsavedChanges: boolean` を1つに畳んでから渡す。

  パンくず・ログアウト・ブラウザを閉じる/再読み込みの3経路は、確認の出し方が違う:
  - パンくず・ログアウト: ページの中の操作なので、**既存の確認ダイアログの部品**
    (`UnsavedChangesDialog` = `Modal` の再利用)で確認できる。`LeaveGuard` がその配線。
  - 閉じる・再読み込み: `beforeunload`。ブラウザ自身が出す確認で、文言はカスタマイズできない
    (`preventDefault`/`returnValue` を立てるだけ)。
*/
import { useEffect, useRef } from "react";

/**
 * `proceed`(実際にその操作を行う関数)を、未保存の変更があるときだけ確認に回す。
 * `hasUnsavedChanges` が false なら確認を挟まずそのまま呼ぶ。
 * true なら呼び出し側(`Header`/`Breadcrumb`)は確認が必要なことを知るだけでよく、
 * **確認そのもの(モーダルの表示・ボタン)はページ側が持つ**(部品を1つに保つため)。
 */
export type LeaveGuard = (proceed: () => void) => void;

/**
 * ブラウザを閉じる・再読み込みする前の確認(`beforeunload`)。
 * ⚠ ブラウザは `beforeunload` のダイアログに任意の文言を出させない(既定の文言は実装依存)ので、
 *   ここでは `preventDefault`/`returnValue` を立てるだけ。
 *
 * 🔴 **実機で確認して直した**: このアプリは静的書き出しなので、パンくず・ログアウトの遷移も
 *   普通の `<a href>`/`location.href` によるページ全体の読み込みで起きる。`UnsavedChangesDialog`
 *   で一度確認を取った直後に、同じ遷移で `beforeunload` のネイティブ確認が**二重に**出た
 *   (Playwright で実測)。`bypassOnce()` を返し、パンくず・ログアウト側が確認を取った直後に
 *   呼んで、その遷移の `beforeunload` だけを黙らせる(閉じる・再読み込み=確認を経由しない経路は
 *   そのまま効く。これも実機で確認した)。
 */
export function useBeforeUnloadGuard(hasUnsavedChanges: boolean): { bypassOnce: () => void } {
  const bypassRef = useRef(false);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    function handler(event: BeforeUnloadEvent) {
      if (bypassRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);
  return {
    bypassOnce: () => {
      bypassRef.current = true;
    },
  };
}
