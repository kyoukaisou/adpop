// @vitest-environment node
//
// ライセンスの分割(要件書 §5-6・本部裁定 2026-09-08)が、**ファイルとして在る**ことを固定する。
// 🔴 分割は最初のコミットから機械的に効かせる —— 混ぜて書くと後から分離できない。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

describe("ライセンスの置き場", () => {
  it("ルートの LICENSE は AGPL-3.0 の全文を持つ", () => {
    const license = read("LICENSE");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 19 November 2007");
    // 全文であること(冒頭だけを貼った状態を弾く)
    expect(license).toContain("TERMS AND CONDITIONS");
    expect(license).toContain("END OF TERMS AND CONDITIONS");
    expect(license.split("\n").length).toBeGreaterThan(600);
  });

  /*
    🔴🔴 **判定の向きを逆にした**(2026-09-08。実測を受けて)。

    以前はここで「**LICENSE の冒頭に分割の案内がある**」ことを固定していた
    (要件書 §5-6 の「ルート `LICENSE` の冒頭に明記」に従ったため)。
    **実測**: public 化してから `gh api repos/kyoukaisou/adpop --jq .license` を撃つと
    **`spdx_id: NOASSERTION`** —— 冒頭の案内(日本語6行+区切り線)で
    **GitHub のライセンス自動判定(licensee)が落ちていた**。
    ⚠ 要件書 §5-6 は**他社の判定結果**(Plausible = `agpl-3.0` / PostHog = `NOASSERTION`)を
      根拠に使っている。**自分が NOASSERTION 側に立つのは、その根拠と矛盾する。**

    ✅ **ルートの `LICENSE` は AGPL-3.0 の全文だけ**にし、分割の案内は
      `LICENSING.md` と `README.md` に置いた(下の it が両方を固定する)。
    ✅ **ここは「案内が混ざっていないこと」を測る** —— 案内を戻したら赤くなる形。
    ⚠ **この検査は GitHub の判定そのものを測っていない**(判定は default branch でしか更新されず、
      API でしか読めない)。測っているのは**判定を落とした当の原因**だけ。
  */
  it("🔴 ルートの LICENSE は AGPL の定型文で始まる(分割の案内が混ざっていない)", () => {
    const head = read("LICENSE").split("\n").slice(0, 8);
    expect(head[0].trim()).toBe("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(head[1].trim()).toBe("Version 3, 19 November 2007");
    expect(head[3]).toContain("Copyright (C) 2007 Free Software Foundation, Inc.");
    // 案内を戻したら、この8行のどこかに現れる
    const headText = head.join("\n");
    expect(headText).not.toContain("packages/embed/");
    expect(headText).not.toContain("MIT");
    expect(headText).not.toContain("LICENSING.md");
  });

  it("packages/embed/LICENSE は MIT の全文を持つ", () => {
    const license = read("packages/embed/LICENSE");
    expect(license.startsWith("MIT License")).toBe(true);
    expect(license).toContain("Permission is hereby granted, free of charge");
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it("埋め込みパッケージの npm 名は adpop-js(要件書 §9 案1)", () => {
    const pkg = JSON.parse(read("packages/embed/package.json"));
    expect(pkg.name).toBe("adpop-js");
    expect(pkg.license).toBe("MIT");
    // ⚠ publish は公開ゲート(社長承認)の後。それまで private を外さない。
    expect(pkg.private).toBe(true);
  });

  it("ルートの package.json は AGPL-3.0 を名乗る", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.license).toBe("AGPL-3.0-only");
    expect(pkg.private).toBe(true);
  });

  it("分割の案内は LICENSING.md と README の両方にある(LICENSE から移した先)", () => {
    expect(existsSync(path.join(REPO_ROOT, "LICENSING.md"))).toBe(true);

    const licensing = read("LICENSING.md");
    expect(licensing).toContain("packages/embed/");
    expect(licensing).toContain("MIT");
    expect(licensing).toContain("AGPL-3.0");

    /*
      ⚠ README は**冒頭**に置く。`LICENSE` から案内を外した以上、
        **最初に開くファイルで分割が分からないと、どこにも書いていないのと同じ**になる。
    */
    const readmeHead = read("README.md").split("\n").slice(0, 6).join("\n");
    expect(readmeHead).toContain("packages/embed/");
    expect(readmeHead).toContain("MIT");
    expect(readmeHead).toContain("AGPL-3.0");
    expect(readmeHead).toContain("LICENSING.md");
  });
});
