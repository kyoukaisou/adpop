/*
  配信(`wrangler.delivery.jsonc`)と管理画面(`wrangler.admin.jsonc`)が、同じ D1 を指しているかを見る
  純粋関数。「目で見比べる」をやめ、deploy 前の検査(`scripts/check-database-ids-match.mjs`)と
  テスト(`tests/admin-config.test.ts`)の両方がこの1本だけを呼ぶ(Codex r1 Blocker 4)。

  片方だけ別の有効な id に差し替えると、マイグレーションも両 deploy も**成功したまま**
  配信と管理画面が別の D1 を見る(どちらのコマンドもエラーにならない)。
*/

/** `database_id` が片方または両方読めない/一致しない場合に問題点を返す(0件なら合格)。 */
export function databaseIdMismatchProblems({ deliveryDatabaseId, adminDatabaseId }) {
  if (!deliveryDatabaseId || !adminDatabaseId) {
    return [
      `database_id が読めない(delivery=${deliveryDatabaseId ?? "(無し)"} / admin=${adminDatabaseId ?? "(無し)"})`,
    ];
  }
  if (deliveryDatabaseId !== adminDatabaseId) {
    return [
      `wrangler.delivery.jsonc と wrangler.admin.jsonc の database_id が一致しない` +
        `(delivery=${deliveryDatabaseId} / admin=${adminDatabaseId})。配信と管理画面が別の D1 を見ます。`,
    ];
  }
  return [];
}
