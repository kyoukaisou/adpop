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

  it("ルートの LICENSE の冒頭に、どのディレクトリがどちらかが書いてある", () => {
    const head = read("LICENSE").split("\n").slice(0, 8).join("\n");
    expect(head).toContain("packages/embed/");
    expect(head).toContain("MIT");
    expect(head).toContain("AGPL-3.0");
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

  it("分割の説明(LICENSING.md)が在り、README から辿れる", () => {
    expect(existsSync(path.join(REPO_ROOT, "LICENSING.md"))).toBe(true);
    expect(read("README.md")).toContain("LICENSING.md");
  });
});
