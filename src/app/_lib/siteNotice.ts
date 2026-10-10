/*
  サイト画面の「稼働中のポップがありません」案内を出すかどうか(Codex 1巡目 Blocker・本部裁定)。

  🔴 以前は `popups !== null && popups.length > 0 && !popups.some(active)` を JSX の中に
    直接書いていた。一度表示した後の **再取得**(稼働にする/停止する等の操作後の `load()`)が
    失敗した `reloadError` のときに、`popups` state が**前回成功したときの古い値のまま**残る
    ことを見落としていた —— 「稼働にする」が実際には成功していても、直後の再取得が失敗すれば
    古い(稼働していない)popups で判定し続け、案内が誤って出続ける。

  この分岐は DOM・React 無しでテストできる純粋関数にしてある(`siteNotice.test.ts`。
  `pageLoad.ts`/`nextLoadErrorState` と同じ考え方)。
*/
import { ApiPopup } from "./types";

/**
 * @param popups 読み込み中・初回失敗なら null。それ以外は(アーカイブ済みも含む)全ポップ
 * @param reloadError 一度表示した後の再取得が失敗している間(= popups が古いデータの可能性がある)
 */
export function shouldShowNoActivePopupNotice(popups: ApiPopup[] | null, reloadError: boolean): boolean {
  // 読み込み中・初回失敗 = 「無い」と確認できていない(P-011と同じ考え方。無いことを確認できるまで言わない)
  if (popups === null) return false;
  // 🔴 再取得が失敗している間は popups が最新かどうか分からない。古いデータで案内を出さない
  if (reloadError) return false;
  /*
    🔴 画面の「ポップ」一覧(アーカイブ済みを含まない表の側)が空のときは、既存の
    `EmptyState`(「まだポップがありません」)に任せる(帯の二重表示を避ける)。
    ⚠ `popups.length === 0`(1件も無い)だけでなく、**アーカイブ済みだけ**(非アーカイブが0件)
    のときも `EmptyState` 側が表示される(site/page.tsx の `active = popups.filter(archivedAt===null)`
    と同じ絞り込み)ので、ここも同じ基準(非アーカイブの件数)で判定する。
  */
  const nonArchived = popups.filter((p) => p.archivedAt === null);
  if (nonArchived.length === 0) return false;
  return !nonArchived.some((p) => p.status === "active");
}
