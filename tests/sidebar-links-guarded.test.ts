// @vitest-environment node
//
// D-384 Codexレビュー指摘4: サイドバー・ドロワー・サイト切替・パンくずの中の `<a>` タグは、
// `GuardedLink` コンポーネントを経由する。これまで「タグの設置」カード・「すべてのサイトを管理」
// が素の `<a>` のままで、ポップ編集中の未保存確認を通らずに離脱できていた(レビュー指摘)。
// ⚠ サイト切替の候補一覧は `<button>`(リンクではない)なので、ここでは検査対象にしていない
//   (`SiteSwitcher.tsx` の `navigate()` が同じ `resolveGuardedClick` を直接呼ぶ。コードで確認)。
//
// 🔴 このリポジトリはまだReactコンポーネントの描画検査を持たない(vitest.config.mts参照)ため、
//   「新しい素の<a>がこの4ファイルに紛れ込んでいないか」を**ソースの字面**で機械的に検査する。
//   論理(ガードが実際に効くか)は `guardedLink.test.ts` が撃つ。ここは「漏れていないか」だけを見る。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");

/** 行頭が `//` の行・`/* ... *‌/` のブロックコメントの中の行を除いた、実際のコードの行だけを返す。 */
function codeLines(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    // JSXコメント `{/* ... */}` も通常のブロックコメント `/* ... */` と同じに扱う
    const withoutJsxWrap = trimmed.replace(/^\{\s*/, "");
    if (withoutJsxWrap.startsWith("/*")) {
      if (!withoutJsxWrap.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    out.push(line);
  }
  return out;
}

const FILES = [
  "src/app/_components/Sidebar.tsx",
  "src/app/_components/SiteSwitcher.tsx",
  "src/app/_components/Breadcrumb.tsx",
  "src/app/_components/AppShell.tsx",
];

describe("サイドバー・ドロワー・サイト切替・パンくずに、素の <a> が紛れ込んでいないか", () => {
  for (const relativePath of FILES) {
    it(`🔴 ${relativePath} に JSX の素の <a ...> が無い(全部 GuardedLink 経由)`, () => {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      const rawAnchors = codeLines(source).filter((line) => /<a[\s>]/.test(line));
      expect(rawAnchors, `素の<a>が見つかった行:\n${rawAnchors.join("\n")}`).toEqual([]);
    });
  }

  it("⚠ 変異検査: 検査自体が効いているか(素の<a>を1行差し込むと落ちる)", () => {
    const withRawAnchor = codeLines('export function X() {\n  return <a href="/x">leak</a>;\n}');
    const rawAnchors = withRawAnchor.filter((line) => /<a[\s>]/.test(line));
    expect(rawAnchors.length).toBeGreaterThan(0);
  });

  it("🔴 GuardedLink.tsx 自体は `<a` を持ってよい(実体はここにしか無い)", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/app/_components/GuardedLink.tsx"), "utf8");
    const rawAnchors = codeLines(source).filter((line) => /<a[\s>]/.test(line));
    expect(rawAnchors.length).toBeGreaterThan(0);
  });
});
