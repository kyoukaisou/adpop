#!/usr/bin/env node
/*
  埋め込みスクリプトを束ね、**2か所**へ書き出す。

    ① `packages/embed/dist/`  …… パッケージ(`adpop-js`)の成果物
    ② `public/embed/`         …… **Next.js が URL の root で配る場所**(`/embed/t.js`)

  🔴 **②を git に入れない**(`.gitignore`)。ビルドの出力をリポジトリに置くと、
    ソースを直した人が書き出しを忘れたとき、**古い出力が配られ続ける**。
    → `npm run build` / `npm run dev` の**前に必ず走らせる**(package.json)。
  ⚠ 本番(Vercel)は `npm run build` を走らせるので、そこで作られる。
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLES } from "./bundle-size.mjs";
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
