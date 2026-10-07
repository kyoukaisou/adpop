/*
  配信元(NEXT_PUBLIC_DELIVERY_ORIGIN)の「確定した値」を、リポジトリの中の1か所
  (`deploy/delivery-origin.txt`)だけが持つ。レビュー指摘への対応:
  前巡の検査(`adpop-delivery\.[a-z0-9-]+\.workers\.dev` の形であれば通す)は、
  **別のアカウント名でもタイプミスでも通ってしまう**(CI のダミー値が本番値と同じ扱いで
  通っていたのがその実例)。この検査は「形」ではなく「このファイルに書かれた値と完全一致するか」
  だけを見る。

  🔴 実測で確かめた事実: `wrangler whoami` の権限では、アカウントの workers.dev サブドメイン名を
  読めない。さらに、**初めて workers.dev へ deploy するまでサブドメインが登録されていない可能性がある**
  (登録を求められる)。そのため、このファイルの初期値は実在しない配信元ではなく、
  「未確定」を表す定数 `UNSET` にしてある。実在する値を**先に決めてコミットしてから deploy する**
  (docs/deploy.md §5)。

  ⚠ **検討したが入れなかったもの**: 「CI 専用と分かる形(`.invalid` 等)の値を、この関数自身が
  常に拒否する」という追加の層。これは一見筋が良さそうに見えるが、**CI がこの関数を通すために
  まさにその `.invalid` の値を使う**ため、常時拒否を入れると CI 自身の dry-run も落ちてしまう
  (本番と CI が同じ `build.command` を経由する以上、同じ関数を両方が呼ぶ)。
  CI 専用の値を本番の deploy から隔離しているのは、この関数の中の特別な分岐ではなく、
  **CI がこの値をコミットせず、ジョブのワークスペースの中だけに書くこと**(`.github/workflows/ci.yml`)
  そのものである。もし CI の値がうっかりコミットされたら、`tests/delivery-origin-guard.test.ts` の
  「現在の状態は UNSET」という検査がその時点で落ちる(コミットされた値は `UNSET` という既知の定数とは
  一致しないため)。
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DELIVERY_ORIGIN_FILE = path.join(REPO_ROOT, "deploy", "delivery-origin.txt");

/** まだ確定していないことを表す値(`deploy/delivery-origin.txt` の初期値)。 */
export const UNSET_DELIVERY_ORIGIN = "UNSET";

/** `deploy/delivery-origin.txt` を読む(無ければ未確定として扱う)。 */
export function readExpectedDeliveryOrigin() {
  try {
    return readFileSync(DELIVERY_ORIGIN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * 期待する配信元(`deploy/delivery-origin.txt` の値)と、実際に渡された
 * `NEXT_PUBLIC_DELIVERY_ORIGIN` を比べる。問題が無ければ `[]`。
 * - ファイルが未確定(空 / `UNSET`)なら、値の中身を見るより前に止める
 * - **完全一致**でなければ止める(1文字違い・別アカウント名も含む。形の一致では合格にしない)
 */
export function deliveryOriginGuardProblems({ actualOrigin, expectedOrigin }) {
  const expected = (expectedOrigin ?? "").trim();
  if (expected === "" || expected === UNSET_DELIVERY_ORIGIN) {
    return [
      `配信元がまだ確定していない(${DELIVERY_ORIGIN_FILE} が ${UNSET_DELIVERY_ORIGIN} のまま)。` +
        `docs/deploy.md §5 の手順で確定させ、コミットしてから deploy してください。`,
    ];
  }
  const actual = actualOrigin ?? "";
  if (actual !== expected) {
    return [
      `NEXT_PUBLIC_DELIVERY_ORIGIN が deploy/delivery-origin.txt の値と完全には一致しない` +
        `(expected=${JSON.stringify(expected)} / actual=${JSON.stringify(actual)})`,
    ];
  }
  return [];
}
