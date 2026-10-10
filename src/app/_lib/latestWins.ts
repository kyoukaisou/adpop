/*
  「最後に発行したものだけを勝たせる」世代管理(D-384 Codexレビュー指摘1)。
  期間切り替え(ダッシュボードの7/30/90日)のように、短い間隔で複数回発行される非同期処理が
  発行順どおりに返ってくるとは限らないとき、**最後に発行した分の結果だけ**を反映させるために使う。
  DOM・Reactに依存しない形にして、順不同の応答(遅い方が後から届く等)をテストで固定できるようにする。
*/
export function createLatestWinsGuard() {
  let current = 0;
  return {
    /** 新しいリクエストを発行するときに呼ぶ。発行のたびに違う印を返す。 */
    next(): number {
      current += 1;
      return current;
    },
    /** その印が、いちばん最後に発行されたものと一致するか。 */
    isLatest(id: number): boolean {
      return id === current;
    },
  };
}

/**
 * `fetcher()` を実行し、**それより後に `fetchLatestWins` が呼ばれていなければ** `onResult` を呼ぶ。
 * 🔴 `onStart` は `fetcher` を呼ぶ**前**に同期的に呼ぶ(「読み込み中」への切り替えを、
 *   応答を待たずに即座に反映するため。Codexレビュー指摘1「再取得の間は古い期間の数字を
 *   最新として出し続けない」)。
 */
export async function fetchLatestWins<T>(
  guard: ReturnType<typeof createLatestWinsGuard>,
  fetcher: () => Promise<T>,
  onStart: () => void,
  onResult: (result: T) => void,
): Promise<void> {
  const id = guard.next();
  onStart();
  const result = await fetcher();
  if (!guard.isLatest(id)) return; // この応答より後のリクエストが既に発行済み(古い応答は無視)
  onResult(result);
}
