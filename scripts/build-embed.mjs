#!/usr/bin/env node
/*
  埋め込みスクリプトを束ね、**2か所**へ書き出す。

    ① `packages/embed/dist/`  …… パッケージ(`adpop-js`)の成果物
    ② `dist/delivery-assets/embed/` …… **配信の Worker が URL の root で配る場所**(`/embed/t.js`)
       + 同じディレクトリに `_headers`(キャッシュの指定。Workers の静的配信が読む)

  🔴 **②を git に入れない**(`.gitignore`)。ビルドの出力をリポジトリに置くと、
    ソースを直した人が書き出しを忘れたとき、**古い出力が配られ続ける**。
    → `npm run build` / `npm run dev` の**前に必ず走らせる**(package.json)。
  ⚠ `npm run delivery:dev` も先にこれを走らせる。
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLES, DELIVERY_ASSETS_DIR } from "./bundle-size.mjs";
import { buildEmbedBundle, REPO_ROOT } from "./embed-build.mjs";

for (const bundle of BUNDLES) {
  const { code } = await buildEmbedBundle(bundle);
  for (const relative of [bundle.out, bundle.publicOut]) {
    const target = path.join(REPO_ROOT, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, code);
  }
  console.log(`OK  ${bundle.entry} → ${bundle.out} / ${bundle.publicOut} (${code.length} B)`);
}

/*
  🔴 **短めのキャッシュ(5分)**(旧 next.config.ts の headers() から移した)。
    ・長くすると、**壊れた版を配ったときに戻すのが遅くなる**(他人の LP に載っている)
    ・短すぎると、全訪問者が毎回取りに行く
  ⚠ 実測ではなく実測に基づかない設計値。
*/
const ASSET_HEADERS = `/embed/*
  Cache-Control: public, max-age=300, s-maxage=300
`;
writeFileSync(path.join(REPO_ROOT, DELIVERY_ASSETS_DIR, "_headers"), ASSET_HEADERS);
console.log(`OK  ${DELIVERY_ASSETS_DIR}/_headers`);
