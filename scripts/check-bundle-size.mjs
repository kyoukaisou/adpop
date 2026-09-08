#!/usr/bin/env node
/*
  埋め込みスクリプトを実際にビルドして、gzip 後の大きさを上限(要件書 §5-1)と突き合わせる。
  超えていたら**非ゼロで終わる**(CI が落ちる)。

  ⚠ **PR1 の時点では中身が空**なので、この検査はまだ何も守っていない。
    守り始めるのは PR2 で本体が入ってから。**判定そのもの**が正しいことは
    `tests/bundle-size.test.ts` が両側(超える / 超えない)で固定している。
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLES, evaluateSizes, formatReport, gzipSizeOf } from "./bundle-size.mjs";
import { buildEmbedBundle, REPO_ROOT as ROOT } from "./embed-build.mjs";

const measured = {};
for (const bundle of BUNDLES) {
  const { code } = await buildEmbedBundle(bundle);
  const outPath = path.join(ROOT, bundle.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, code);
  measured[bundle.id] = gzipSizeOf(code);
}

const result = evaluateSizes(measured);
console.log("埋め込みスクリプトの大きさ(要件書 §5-1 の上限):");
console.log(formatReport(result));

if (!result.ok) {
  console.error("\n上限を超えています。依存を足していないか、本体をローダに混ぜていないかを見てください。");
  process.exit(1);
}
