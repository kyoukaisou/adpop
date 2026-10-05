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
 * `proceed`(実際にその操作を行う関数)を、未保存の変更・進行中の操作があるときだけ確認に回す。
 * `blocksLeaving` が false なら確認を挟まずそのまま呼ぶ。
 * true なら呼び出し側(`Header`/`Breadcrumb`)は確認が必要なことを知るだけでよく、
 * **確認そのもの(モーダルの表示・ボタン)はページ側が持つ**(部品を1つに保つため)。
 *
 * 🔴 Codex r1 Should fix: `proceed` は「実際に離脱(遷移)できたか」を `boolean` で返す。
 *   ログアウトのように `proceed` が失敗して画面に留まる経路があるため、呼び出し側(ページ)が
 *   `bypassOnce()` で武装した `beforeunload` の抑止を、離脱できなかったときに `cancelBypass()`
 *   で解除できるようにする(でないと、次の本当の離脱でも確認が出なくなる)。
 */
export type LeaveGuard = (proceed: () => Promise<boolean> | boolean) => void;

/**
 * `beforeunload` の実際の DOM 配線(React に依存しない。JSDOM で直接テストできる。
 * `tests/embed-flow.test.ts` と同じ考え方で、React のレンダーを介さずに検証する)。
 * `isBypassed`/`consumeBypass` で「1回だけ黙らせる」フラグの読み書きを外側(フック)に委ねる。
 */
export function attachBeforeUnloadGuard(win: Window, isBypassed: () => boolean, consumeBypass: () => void): () => void {
  function handler(event: Event) {
    if (isBypassed()) {
      // 🔴 Codex r1 Should fix: 以前はここで何もしておらず、一度 bypass すると二度と戻らなかった
      //   (以後の beforeunload が永久に抑止され続けた)。使ったら即座に消費する=「1回だけ」を
      //   文字どおり1回だけにする。
      consumeBypass();
      return;
    }
    const e = event as BeforeUnloadEvent;
    e.preventDefault();
    e.returnValue = "";
  }
  win.addEventListener("beforeunload", handler);
  return () => win.removeEventListener("beforeunload", handler);
}

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
 * 🔴 **Codex r1 Should fix**: `bypassOnce()` が戻らない(一度 true にすると永久に `beforeunload`
 *   が抑止される)バグがあった。`attachBeforeUnloadGuard` 側で「使ったら消費する」形にし、かつ
 *   `cancelBypass()` を公開して、**離脱に失敗した**(例: ログアウトAPIが失敗して画面に残った)
 *   ときに呼び出し側(`popup/page.tsx`)が明示的に武装解除できるようにした。
 */
export function useBeforeUnloadGuard(hasUnsavedChanges: boolean): { bypassOnce: () => void; cancelBypass: () => void } {
  const bypassRef = useRef(false);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    return attachBeforeUnloadGuard(
      window,
      () => bypassRef.current,
      () => {
        bypassRef.current = false;
      },
    );
  }, [hasUnsavedChanges]);
  return {
    bypassOnce: () => {
      bypassRef.current = true;
    },
    cancelBypass: () => {
      bypassRef.current = false;
    },
  };
}
