/*
  親の再取得(load())が失敗したときに、どちらのエラー状態にするか(レビュー指摘)。

  🔴 以前は、一度表示した後の再取得(保存後の `onSaved()` 等)が失敗しても、初回の読み込み失敗と
    同じ `loadError` を立てていた。ポップ編集画面(src/app/popup/page.tsx)はこれで**編集画面全体を
    エラー画面に置き換えており**、全 `VariantCard` がアンマウントされ、未保存の入力が消えていた。

  設計の決定:
  - 編集画面を丸ごとエラー画面にするのは「最初の読み込みに失敗したとき」(=まだ何も表示できていない)
    だけにする
  - 一度表示した後の再取得の失敗では、今の画面(カードと入力)をそのまま残し、上部にエラーの帯を出す
  - サイトの画面・サイト一覧も、書きかけの入力こそ無いが、最初の読み込みと後の再取得で動きを揃える

  この分岐は DOM・React 無しでテストできる純粋関数にしてある(`pageLoad.test.ts`)。
*/

export type LoadErrorState = { loadError: boolean; reloadError: boolean };

/**
 * @param ok 今回の取得が成功したか
 * @param hasLoadedOnce これまでに一度でも成功して画面を表示できているか
 */
export function nextLoadErrorState(ok: boolean, hasLoadedOnce: boolean): LoadErrorState {
  if (ok) return { loadError: false, reloadError: false };
  return hasLoadedOnce ? { loadError: false, reloadError: true } : { loadError: true, reloadError: false };
}
