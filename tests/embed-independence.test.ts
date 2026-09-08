// @vitest-environment node
//
// `packages/embed/`(MIT)が AGPL 側を読まないことの検査を、**両側**で固定する。
// ⚠ 実物は今きれいなので、実物だけを測っても「検査が働くか」は分からない。
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectEmbedFiles, EMBED_ROOT } from "../scripts/embed-files.mjs";
import { findViolations, importSpecifiers, violationOf } from "../scripts/embed-independence.mjs";

const REPO_ROOT = path.resolve(__dirname, "..");

describe("import の拾い方", () => {
  it("import / export from / dynamic import / require を拾う", () => {
    const source = [
      `import { a } from "./a";`,
      `export { b } from "../b";`,
      `const c = await import("./c");`,
      `const d = require("d");`,
      `import "./side-effect";`,
    ].join("\n");
    expect(importSpecifiers(source).sort()).toEqual(
      ["../b", "./a", "./c", "./side-effect", "d"].sort(),
    );
  });
});

describe("判定(violationOf)", () => {
  it("同じディレクトリ・下のディレクトリの相対 import は通す", () => {
    expect(violationOf("./triggers", "src")).toBeNull();
    expect(violationOf("./shadow/render", "src")).toBeNull();
    expect(violationOf("../src/loader", "src/triggers")).toBeNull();
  });

  it("🔴 packages/embed/ の外へ出る相対 import を弾く", () => {
    expect(violationOf("../../../src/lib/db", "src")).toMatch(/外/);
    // packages/embed/src から 2つ上がると packages/ = もう外
    expect(violationOf("../../server", "src")).toMatch(/外/);
  });

  it("🔴 別名 @/ (AGPL 側の src)を弾く", () => {
    expect(violationOf("@/lib/supabase", "src")).toMatch(/AGPL/);
  });

  it("🔴 外部パッケージと Node の組み込みを弾く(依存ゼロが要件)", () => {
    expect(violationOf("react", "src")).toMatch(/依存ゼロ/);
    expect(violationOf("node:crypto", "src")).toMatch(/依存ゼロ/);
  });
});

describe("実物", () => {
  it(`${EMBED_ROOT} に検査対象のファイルが在る(0件で緑にならない)`, () => {
    expect(collectEmbedFiles(REPO_ROOT).length).toBeGreaterThan(0);
  });

  it("実物に違反が無い", () => {
    expect(findViolations(collectEmbedFiles(REPO_ROOT))).toEqual([]);
  });

  it("🔴 違反を1件混ぜると検出される(検査が空回りしていない)", () => {
    const files = [
      ...collectEmbedFiles(REPO_ROOT),
      { path: "packages/embed/src/bad.ts", dir: "src", source: `import { db } from "@/lib/db";` },
    ];
    expect(findViolations(files)).toHaveLength(1);
  });
});
