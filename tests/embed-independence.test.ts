// @vitest-environment node
//
// `packages/embed/`(MIT)が AGPL 側を読まないことの検査を、**両側**で固定する。
// ⚠ 実物は今きれいなので、実物だけを測っても「検査が働くか」は分からない。
//
// 🔴 **Codex 1巡目(2026-09-08)で、正規表現の版に2つの抜け方が実在した。**
//   その2つを**そのまま「落ちる例」として**、esbuild に実際に解決させて撃つ。
//   ⚠ 合成した metafile を渡すだけでは足りない —— 抜けたのは
//     「**esbuild は解決するのに、こちらの走査が見つけられない**」という差なので、
//     **本物のビルドを通さないと同じことを測っていない。**
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BUNDLES } from "../scripts/bundle-size.mjs";
import { buildEmbedBundle } from "../scripts/embed-build.mjs";
import {
  EMBED_ROOT,
  measurementProblems,
  metafileViolations,
} from "../scripts/embed-independence.mjs";

/** 使い捨ての木に、リポジトリと同じ形(`packages/embed/src/...` と `src/...`)を作る。 */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "adpop-embed-"));
  for (const [relative, source] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

async function metafileOf(root: string, entry: string) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "silent",
    absWorkingDir: root,
  });
  return result.metafile;
}

const trees: string[] = [];
afterAll(() => {
  for (const root of trees) rmSync(root, { recursive: true, force: true });
});

describe("Codex 1巡目で実在した抜け方(正規表現の版が素通ししたもの)", () => {
  it("🔴 空白の無い `import{x}from\"…\"` でも捕まえる(Astra の例)", async () => {
    const root = makeTree({
      "packages/embed/src/loader.ts": `import{metadata}from"../../../src/app/layout";\nexport const v = metadata;\n`,
      "src/app/layout.ts": `export const metadata = { title: "ADPOP" };\n`,
    });
    trees.push(root);
    const metafile = await metafileOf(root, "packages/embed/src/loader.ts");
    const violations = metafileViolations(metafile);
    expect(violations.map((v) => v.input)).toEqual(["src/app/layout.ts"]);
  });

  it("🔴 `.jsx` を1枚挟んだ迂回でも捕まえる(sol の例)", async () => {
    const root = makeTree({
      "packages/embed/src/loader.ts": `import { bridge } from "./bridge.jsx";\nexport const v = bridge;\n`,
      "packages/embed/src/bridge.jsx": `import { secret } from "../../../src/lib/db";\nexport const bridge = secret;\n`,
      "src/lib/db.ts": `export const secret = 1;\n`,
    });
    trees.push(root);
    const metafile = await metafileOf(root, "packages/embed/src/loader.ts");
    // 🔴 迂回の板(bridge.jsx)は MIT 側なので違反ではない。**その先だけ**が違反。
    expect(metafileViolations(metafile).map((v) => v.input)).toEqual(["src/lib/db.ts"]);
  });

  it("🔴 外部パッケージを読んだら捕まえる(依存ゼロが要件)", async () => {
    const root = makeTree({
      "packages/embed/src/loader.ts": `import { thing } from "tiny-dep";\nexport const v = thing;\n`,
      "node_modules/tiny-dep/package.json": `{"name":"tiny-dep","version":"1.0.0","main":"index.js"}`,
      "node_modules/tiny-dep/index.js": `export const thing = 1;\n`,
    });
    trees.push(root);
    const metafile = await metafileOf(root, "packages/embed/src/loader.ts");
    const violations = metafileViolations(metafile);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/依存ゼロ/);
  });

  it("✅ MIT の中で閉じた相対 import は通る(締めすぎていないこと)", async () => {
    const root = makeTree({
      "packages/embed/src/loader.ts": `import { t } from "./triggers/back";\nexport const v = t;\n`,
      "packages/embed/src/triggers/back.ts": `export const t = 1;\n`,
    });
    trees.push(root);
    const metafile = await metafileOf(root, "packages/embed/src/loader.ts");
    expect(metafileViolations(metafile)).toEqual([]);
    expect(Object.keys(metafile.inputs)).toHaveLength(2);
  });
});

describe("測れていることの確認(0件を合格にしない)", () => {
  it("🔴 metafile が空なら「違反0」ではなく「測っていない」", () => {
    expect(measurementProblems({ inputs: {} }, "packages/embed/src/loader.ts")).toHaveLength(1);
    expect(metafileViolations({ inputs: {} })).toEqual([]);
  });

  it("🔴 入口が入力に無ければ問題として挙げる", () => {
    const metafile = { inputs: { "packages/embed/src/other.ts": {} } };
    expect(measurementProblems(metafile, "packages/embed/src/loader.ts")).toHaveLength(1);
  });
});

describe("実物", () => {
  it("判定の基準になるディレクトリは packages/embed/", () => {
    expect(EMBED_ROOT).toBe("packages/embed/");
  });

  it.each(BUNDLES)("$entry は packages/embed/ の外を1つも読んでいない", async (bundle) => {
    const { metafile } = await buildEmbedBundle(bundle, { metafile: true });
    // 🔴 metafile が返ってこなかったら「違反0」ではなく、測れていない
    if (!metafile) throw new Error(`${bundle.entry}: metafile が返ってこなかった`);
    expect(measurementProblems(metafile, bundle.entry)).toEqual([]);
    expect(metafileViolations(metafile)).toEqual([]);
  });
});
