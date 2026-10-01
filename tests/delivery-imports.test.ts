// @vitest-environment node
//
// 🔴 **配信の Worker の束に、画像の書き込み・削除と管理画面のコードを入れない**(設計 4 章)。
//   R2 のバインドは「読むだけ」に絞る設定が無い(wrangler の設定項目に無い)ので、**コードの側で**絞る。
//   束ねたときに実際に解決された入力(esbuild の metafile)で判定する(書き方の違いで抜けない)。
import { build } from "esbuild";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

async function inputsOf(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    absWorkingDir: ROOT,
  });
  return Object.keys(result.metafile.inputs).sort();
}

describe("配信の Worker が読むもの", () => {
  it("🔴 書き込みの images.ts・管理画面のデータ層・管理画面の API を含まない", async () => {
    const inputs = await inputsOf("src/delivery/worker.ts");
    expect(inputs, "束が空 = 何も測っていない").toContain("src/delivery/worker.ts");
    expect(inputs).toContain("src/lib/data/image-read.ts");
    for (const forbidden of ["src/lib/data/images.ts", "src/lib/data/admin.ts", "src/lib/data/auth.ts"]) {
      expect(inputs, forbidden).not.toContain(forbidden);
    }
    expect(inputs.filter((i) => i.startsWith("src/admin/"))).toEqual([]);
  });
});
