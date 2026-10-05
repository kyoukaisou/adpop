/*
  `out/_headers` が CSP を失っていないかを見る純粋関数。
  背景: 本番前の点検(2026-10-05)。`wrangler deploy -c wrangler.admin.jsonc` は `out/` をそのまま配り、
  `_headers` の有無を見ない。`next build` だけで止めた `out/`(`npm run build` の `build:admin-headers`
  工程を通っていない)を deploy すると、CSP・X-Frame-Options・Referrer-Policy 無しで本番に出る(fail-open)。
  このファイルは「生成ロジック」(`scripts/csp.mjs`)を再利用せず、**出来上がった `_headers` の字面**だけを見る
  (生成側が壊れても、検査側が同じ壊れ方をして気づけない、を避けるため)。

  🔴 Cloudflare の `_headers` はパスのパターンごとにルールが分かれる(`/*` の1行 → インデントされた
  ヘッダの並び → 次の非インデント行で次のルール)。**管理画面は `/*` の1ルールに全ヘッダをまとめる設計**
  (`scripts/build-admin-headers.mjs`)なので、この検査も `/*` のルールだけを見る(ファイル全体の
  どこかにヘッダがあれば合格、ではなく、実際に全画面へ適用されるルールを見る。Codex r1 Should-fix)。

  🔴 配信ドメインは決定済み(`workers.dev` 固定・Worker 名 `adpop-delivery`。README「自前ホスト」/
  `docs/deploy.md` §5)。`NEXT_PUBLIC_DELIVERY_ORIGIN` がこの形と一致しないまま deploy できないよう、
  CSP の `img-src` に決定済みの origin がトークンとして入っているかも見る(Codex r1 Blocker 2)。
*/

/** 決定済みの形(`https://adpop-delivery.<account>.workers.dev`)と一致するかを見る。 */
export function isDecidedDeliveryOrigin(value) {
  return typeof value === "string" && /^https:\/\/adpop-delivery\.[a-z0-9-]+\.workers\.dev$/.test(value);
}

/** `_headers` を「パスパターン → ヘッダ名 → 値」のルールの配列に分ける(非インデント行がルールの境目)。 */
export function parseHeaderBlocks(headersContent) {
  const blocks = [];
  let current = null;
  for (const raw of headersContent.split("\n")) {
    if (raw.trim() === "") continue;
    if (!/^\s/.test(raw)) {
      current = { path: raw.trim(), headers: {} };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const match = raw.match(/^\s*([A-Za-z-]+):\s*(.+)$/);
    if (match) current.headers[match[1]] = match[2].trim();
  }
  return blocks;
}

function directives(csp) {
  return csp.split(";").map((d) => d.trim()).filter(Boolean);
}

/**
 * `_headers` の中身から問題点を一覧で返す(0件なら合格)。見るのは**`/*` のルールだけ**
 * (実際に全画面へ適用されるルール。他のパスだけに正しいヘッダがあっても合格にしない)。
 * - `/*` ルール自体が無い
 * - `Content-Security-Policy` 行が無い / 空
 * - `script-src` に `'unsafe-inline'` または `'unsafe-eval'` が入っている(設計上使わない。M8)
 * - `img-src` に、決定済みの配信元(`NEXT_PUBLIC_DELIVERY_ORIGIN`)がトークンとして入っていない
 * - `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` が無い
 */
export function headersGuardProblems({ headersContent, deliveryOrigin }) {
  const problems = [];
  const rootBlock = parseHeaderBlocks(headersContent).find((b) => b.path === "/*");

  if (!rootBlock) {
    problems.push("`/*` のルールが無い(next build だけで止めた out/ を deploy しようとしていないか)");
    return problems;
  }

  const csp = rootBlock.headers["Content-Security-Policy"];
  if (!csp) {
    problems.push("`/*` のルールに Content-Security-Policy が無い");
  } else {
    const directiveList = directives(csp);
    const scriptSrc = directiveList.find((d) => d.startsWith("script-src"));
    if (scriptSrc && (scriptSrc.includes("'unsafe-inline'") || scriptSrc.includes("'unsafe-eval'"))) {
      problems.push(`script-src に 'unsafe-inline' または 'unsafe-eval' が入っている: ${scriptSrc}`);
    }

    if (!isDecidedDeliveryOrigin(deliveryOrigin)) {
      problems.push(
        `NEXT_PUBLIC_DELIVERY_ORIGIN が未指定か、決定済みの形(https://adpop-delivery.<account>.workers.dev)` +
          `と一致しない: ${JSON.stringify(deliveryOrigin ?? null)}`,
      );
    } else {
      const imgSrc = directiveList.find((d) => d.startsWith("img-src"));
      if (!imgSrc || !imgSrc.split(" ").includes(deliveryOrigin)) {
        problems.push(`img-src に配信元(${deliveryOrigin})がトークンとして入っていない: ${imgSrc ?? "(img-src 無し)"}`);
      }
    }
  }

  for (const name of ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]) {
    if (!rootBlock.headers[name]) {
      problems.push(`\`/*\` のルールに ${name} が無い`);
    }
  }

  return problems;
}

/**
 * 決定済みの配信元(`NEXT_PUBLIC_DELIVERY_ORIGIN`)の文字列が、ビルドの出力(`_next` の JS 全部)の
 * どこかに実際に埋め込まれているかを見る。CSP の `img-src` だけを見ても、`next build` を
 * `NEXT_PUBLIC_DELIVERY_ORIGIN` 無しで実行すれば `_headers` 側も img-src から配信元が抜けて
 * 整合してしまう(fail-closed だが「決定済みの値が実際にタグ・サムネイル表示に埋め込まれているか」
 * は別の主張なので、ビルド出力の字面でも確かめる。Codex r1 Blocker 2)。
 */
export function deliveryOriginEmbeddedProblems({ deliveryOrigin, fileContents }) {
  if (!isDecidedDeliveryOrigin(deliveryOrigin)) return [];
  const found = fileContents.some((content) => content.includes(deliveryOrigin));
  if (found) return [];
  return [
    `ビルドの出力(out/_next の JS)のどこにも配信元(${deliveryOrigin})の文字列が見つからない。` +
      `NEXT_PUBLIC_DELIVERY_ORIGIN を渡さずに next build したのではないか`,
  ];
}
