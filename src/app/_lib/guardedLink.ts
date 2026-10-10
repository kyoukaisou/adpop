/*
  `GuardedLink`(D-384 Codexレビュー指摘4)の判定ロジックだけを切り出した純粋関数。
  このリポジトリはまだReactコンポーネントの描画検査を持たない(vitest.config.mts参照)ため、
  「サイドバー・ドロワー・サイト切替・パンくずのリンクが、全部同じガードを通る」ことを
  DOM抜きでテストできるよう、ここに1本化する。`GuardedLink.tsx` はこれを呼ぶだけにする。

  🔴 D-384 Codexレビュー2巡目の指摘: 「主ボタン・修飾キーなしのクリック」だけをガードする。
    Command/Ctrl+クリック(新しいタブで開く)・Shift+クリック(新しいウィンドウ)・中クリック
    (主ボタン以外)・`target="_blank"`・`download` 属性のリンクは、ブラウザの既定の動作
    (新しいタブを開く・ファイルを保存する等)に任せる——いまのタブを離脱確認付きで移動させない。
*/
import type { LeaveGuard } from "./unsavedChanges";

export type GuardedClickDecision =
  // onBeforeLeave が無い、または特殊なクリック = 素の <a> の既定のナビゲーションに任せる(preventDefaultしない)
  | { guarded: false }
  // onBeforeLeave があり、かつ主ボタン・修飾キーなしの通常クリック = preventDefaultした上で、`proceed` を onBeforeLeave に渡す
  | { guarded: true; proceed: () => boolean };

/** クリックの種別を判定するために必要な属性だけを集めたもの(DOMイベント・`<a>`要素そのものには依存しない)。 */
export type ClickModifiers = {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** `MouseEvent.button`。0 = 主ボタン(左クリック)。 */
  button: number;
  /** `<a target="...">` の値。未指定(`undefined`/`null`)は `_self` と同じ扱い。 */
  target?: string | null;
  /** `<a download>` 属性が付いているか(値の中身は問わない。属性の有無だけ見る)。 */
  hasDownload: boolean;
};

/** 既定(主ボタン・修飾キーなし・target指定なし・downloadなし)のクリック。ボタン操作(リンクではない)からの呼び出しで使う。 */
export const PLAIN_CLICK: ClickModifiers = {
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  button: 0,
  target: undefined,
  hasDownload: false,
};

/**
 * ブラウザが「新しいタブ・ウィンドウで開く」「ファイルとして保存する」と解釈する特殊なクリックか。
 * 🔴 この4条件はCodexレビュー2巡目の指摘どおり(修飾キー・主ボタン以外・target≠_self・download)。
 */
export function isSpecialClick(click: ClickModifiers): boolean {
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return true;
  if (click.button !== 0) return true;
  if (click.target !== undefined && click.target !== null && click.target !== "_self") return true;
  if (click.hasDownload) return true;
  return false;
}

/**
 * @param navigate 実際に遷移を起こす関数(本番では `(href) => { window.location.href = href }`)
 * @param click クリックの種別(既定は `PLAIN_CLICK`。リンクではないボタン操作からの呼び出しはこれを使う)
 */
export function resolveGuardedClick(
  href: string,
  onBeforeLeave: LeaveGuard | undefined,
  navigate: (href: string) => void,
  click: ClickModifiers = PLAIN_CLICK,
): GuardedClickDecision {
  if (!onBeforeLeave) return { guarded: false };
  if (isSpecialClick(click)) return { guarded: false };
  return {
    guarded: true,
    proceed: () => {
      navigate(href);
      return true; // 常に実際の遷移を起こす(失敗しうるのはログアウトのAPI呼び出しだけ。GuardedLinkは使わない)
    },
  };
}
