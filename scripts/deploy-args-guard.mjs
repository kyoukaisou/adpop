/*
  `npm run deploy:delivery` / `npm run deploy:admin` が、正規の deploy 経路だと確認する純粋関数。
  判定はこの1本だけが持つ。

  🔴 **背景(レビュー指摘への対応)**: `scripts/check-custom-domain.mjs`(build.command から deploy 前に
  必ず走る)は、固定の `wrangler.*.jsonc` だけを読む。ところが Wrangler の CLI は
  `--route`/`--routes`(`config.routes` を**丸ごと置き換える**。`mergeDeployConfigArgs` の実装)や
  `--domain`/`--domains`(Custom Domain を**追加**する)を持っており、これらを `wrangler deploy` に
  直接渡すと、設定ファイルに書かれた routes とは違う routes で実際に deploy できる。deploy 前の検査は
  設定ファイルしか読まないため、CLI 引数で上書きされた後の routes は検査の対象に入らない —— つまり
  `wrangler deploy --route '*.kyoukaisou.dev/*' -c wrangler.delivery.jsonc` のように直接 `wrangler` を
  呼べば、検査を通過した後に zone route を deploy できてしまう。

  このリポジトリでは、`wrangler` を直接呼ぶことを前提にした迂回経路そのものを塞ぐことはできない
  (`wrangler` 自体のコマンドなので)。代わりに、**正規の deploy 経路を `npm run deploy:delivery` /
  `npm run deploy:admin` の2つに絞り**、このラッパー(`scripts/guarded-deploy.mjs`)が**追加の CLI 引数を
  一切受け付けない**ことで、この経路からは `--route`/`--domain` 等を渡せないようにする。
  ⚠ **これは「wrangler を直接呼ぶ人」を止める仕組みではない。** 運用の約束(docs/deploy.md)として、
  正規の deploy はこの2つのコマンドだけを使うことを求めている。
*/

export const KNOWN_TARGETS = ["delivery", "admin"];

/**
 * deploy のラッパーに渡された引数の問題点を一覧で返す(0件なら合格)。
 * - `target` が `delivery`/`admin` のどちらでもない → 使い方の誤り
 * - `extraArgs`(`target` の後に渡された追加の CLI 引数)が1件でもある → 拒否
 */
export function deployArgsGuardProblems({ target, extraArgs }) {
  const problems = [];
  if (!KNOWN_TARGETS.includes(target)) {
    problems.push(
      `使い方: node scripts/guarded-deploy.mjs <${KNOWN_TARGETS.join("|")}>(渡された値: ${JSON.stringify(target)})`,
    );
    return problems;
  }
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    problems.push(
      `正規の deploy 経路(npm run deploy:${target})には追加の引数を渡せない` +
        `(渡された値: ${JSON.stringify(extraArgs)})。` +
        `wrangler の --route/--routes/--domain/--domains 等は wrangler.*.jsonc の routes を CLI から` +
        `上書き・追加でき、deploy 前の検査(設定ファイルだけを読む)をすり抜ける。`,
    );
  }
  return problems;
}
