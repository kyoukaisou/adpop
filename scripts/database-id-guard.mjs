/*
  配信(`wrangler.delivery.jsonc`)と管理画面(`wrangler.admin.jsonc`)が、同じ D1 を指しているかを見る
  純粋関数。「目で見比べる」をやめ、deploy 前の検査(`scripts/check-database-ids-match.mjs`)と
  テスト(`tests/admin-config.test.ts`)の両方がこの1本だけを呼ぶ。

  片方だけ別の有効な id に差し替えると、マイグレーションも両 deploy も**成功したまま**
  配信と管理画面が別の D1 を見る(どちらのコマンドもエラーにならない)。

  🔴 **仮の値(`wrangler d1 create` で実際に作る前の既定値)は、一致していても断る。**
  前巡は「非空かつ一致」しか見ておらず、両方とも仮の値のまま揃っている状態(= まだ D1 を
  作っていない)を合格にしていた。仮の値かどうかの判定は `isPlaceholderDatabaseId` の1本だけが持つ
  (この値を他のファイルに書き写さない)。
*/

/** `wrangler.*.jsonc` に初期状態で入っている既知の仮の値(両ファイル共通)。 */
export const PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

export function isPlaceholderDatabaseId(id) {
  return id === PLACEHOLDER_DATABASE_ID;
}

/**
 * `database_id` の問題点を一覧で返す(0件なら合格)。各要素は
 * `{ kind: "missing" | "placeholder" | "mismatch", message: string }`。
 * - 片方または両方が読めない → `missing`
 * - 片方または両方が仮の値 → `placeholder`(**一致していても**)
 * - 一致しない → `mismatch`
 */
export function databaseIdMismatchProblems({ deliveryDatabaseId, adminDatabaseId }) {
  if (!deliveryDatabaseId || !adminDatabaseId) {
    return [
      {
        kind: "missing",
        message: `database_id が読めない(delivery=${deliveryDatabaseId ?? "(無し)"} / admin=${adminDatabaseId ?? "(無し)"})`,
      },
    ];
  }

  const problems = [];
  if (isPlaceholderDatabaseId(deliveryDatabaseId)) {
    problems.push({ kind: "placeholder", message: "wrangler.delivery.jsonc の database_id が仮の値のまま" });
  }
  if (isPlaceholderDatabaseId(adminDatabaseId)) {
    problems.push({ kind: "placeholder", message: "wrangler.admin.jsonc の database_id が仮の値のまま" });
  }
  if (deliveryDatabaseId !== adminDatabaseId) {
    problems.push({
      kind: "mismatch",
      message:
        `wrangler.delivery.jsonc と wrangler.admin.jsonc の database_id が一致しない` +
        `(delivery=${deliveryDatabaseId} / admin=${adminDatabaseId})。配信と管理画面が別の D1 を見ます。`,
    });
  }
  return problems;
}
