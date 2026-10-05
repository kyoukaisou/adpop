/*
  `out/_headers` が CSP を失っていないかを見る純粋関数。
  背景: security 監査(notes/本部/セキュリティ監査-ADPOP-本番前-2026-10-05.md P1)。
  `wrangler deploy -c wrangler.admin.jsonc` は `out/` をそのまま配り、`_headers` の有無を見ない。
  `next build` だけで止めた `out/`(`npm run build` の `build:admin-headers` 工程を通っていない)を
  deploy すると、CSP・X-Frame-Options・Referrer-Policy 無しで本番に出る(fail-open)。
  このファイルは「生成ロジック」(`scripts/csp.mjs`)を再利用せず、**出来上がった `_headers` の字面**だけを見る
  (生成側が壊れても、検査側が同じ壊れ方をして気づけない、を避けるため)。
*/

/** `_headers` の `/*` ルールの中から、ヘッダ名に対応する値を1行取り出す(無ければ null)。 */
function headerValue(headersContent, name) {
  const re = new RegExp(`^\\s*${name}:\\s*(.+)$`, "m");
  const match = headersContent.match(re);
  return match ? match[1].trim() : null;
}

/**
 * `_headers` の中身から問題点を一覧で返す(0件なら合格)。
 * - `Content-Security-Policy` 行が無い / 空
 * - `script-src` に `'unsafe-inline'` または `'unsafe-eval'` が入っている(設計上使わない。M8)
 * - `X-Content-Type-Options` / `X-Frame-Options` が無い(ビルド済みの既定値が欠けている)
 */
export function headersGuardProblems(headersContent) {
  const problems = [];

  const csp = headerValue(headersContent, "Content-Security-Policy");
  if (!csp) {
    problems.push("Content-Security-Policy が無い(next build だけで止めた out/ を deploy しようとしていないか)");
  } else {
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
    if (scriptSrc && (scriptSrc.includes("'unsafe-inline'") || scriptSrc.includes("'unsafe-eval'"))) {
      problems.push(`script-src に 'unsafe-inline' または 'unsafe-eval' が入っている: ${scriptSrc}`);
    }
  }

  if (!headerValue(headersContent, "X-Content-Type-Options")) {
    problems.push("X-Content-Type-Options が無い");
  }
  if (!headerValue(headersContent, "X-Frame-Options")) {
    problems.push("X-Frame-Options が無い");
  }

  return problems;
}
