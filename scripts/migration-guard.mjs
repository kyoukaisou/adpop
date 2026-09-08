/*
  「すべてのマイグレーションは、末尾で権限の関門を呼ぶ」を判定するだけのモジュール。

  🔴 **判定の実装はここ1本だけ。** テスト側にも CI 側にも同じ判定を書き写さない
    (写しを作ると、片方だけ直した日にずれる)。
  🔴 **読み込んでも何も実行しない**(`main()` を呼ばない)。副作用のあるモジュールは
    `node -e "import(...)"` で確かめた瞬間に走り出す([[SaaS開発ナレッジ]] 2026-09-08-13)。
*/
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** マイグレーションの末尾に必ず在る1文。**文字列は1か所だけが持つ。** */
export const GUARD_CALL = "select public.adpop_assert_privilege_rules();";

/** 行コメント(`--`)と空行を落とす。⚠ ブロックコメントは使っていないので扱わない。 */
export function meaningfulLines(sql) {
  return sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
}

/**
 * 関門の呼び出しが**最後の文**であるか。
 * ⚠ 「ファイルのどこかに在る」ではなく「最後に在る」を見る ——
 *   途中で呼んでも、その後に足した文は測られない。
 */
export function endsWithGuardCall(sql) {
  const lines = meaningfulLines(sql);
  return lines.length > 0 && lines[lines.length - 1] === GUARD_CALL;
}

export function listMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/** 関門を末尾で呼んでいないマイグレーションのファイル名(空配列 = 全部守れている)。 */
export function migrationsMissingGuard(dir) {
  return listMigrationFiles(dir).filter(
    (file) => !endsWithGuardCall(readFileSync(path.join(dir, file), "utf8")),
  );
}
