// @vitest-environment node
//
// 🔴 **D1 に触ってよいのは `src/lib/data/` の中だけ**(所有者の分離の規則④)。
//   データ層の外で `db.prepare(...)` を書けば、所有者の条件を入れ忘れた SQL がそのまま通る。
//   → TypeScript の**型**で「D1 のオブジェクトのメソッドを呼んでいる箇所」を探し、データ層の外に1つも無いことを見る。
// ⚠ 正規表現で `.prepare(` を数えない —— 別名(`const run = db.prepare.bind(db)` の先の呼び出し)や、
//   同名の別メソッド(RegExp の `exec` など)を取り違える。**型で判定する**。
// ⚠ 限界: `any` に落とした値からの呼び出しは型が D1 でないので見えない(【限界】の it で固定)。
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const D1_TYPES = new Set(["D1Database", "D1PreparedStatement"]);

/** `root` 以下の .ts/.tsx を型付きで読み、D1 の型のメソッドを呼んでいる箇所を返す。 */
function d1CallSites(root: string, files: string[]): Array<{ file: string; line: number; method: string }> {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    baseUrl: ROOT,
    paths: { "@/*": ["./src/*"] },
    types: [],
  });
  const checker = program.getTypeChecker();
  const found: Array<{ file: string; line: number; method: string }> = [];
  for (const source of program.getSourceFiles()) {
    if (!files.includes(path.resolve(source.fileName))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = checker.getTypeAtLocation(node.expression.expression);
        const name = (receiver.aliasSymbol ?? receiver.getSymbol())?.getName();
        if (name !== undefined && D1_TYPES.has(name)) {
          found.push({
            file: path.relative(root, source.fileName),
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            method: node.expression.name.text,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return ts.sys
    .readDirectory(dir, [".ts", ".tsx"], undefined, ["**/*"])
    .filter((file) => !file.endsWith(".d.ts"))
    .map((file) => path.resolve(file));
}

describe("D1 に触る場所", () => {
  it("🔴 src/ のうち D1 のメソッドを呼んでいるのは src/lib/data/ だけ", () => {
    const sites = d1CallSites(ROOT, sourceFiles(path.join(ROOT, "src")));
    expect(sites.length, "データ層の中でも1つも見つからない = 型で見分けられていない").toBeGreaterThan(0);
    const outside = sites.filter((site) => !site.file.startsWith(path.join("src", "lib", "data") + path.sep));
    expect(outside).toEqual([]);
  });

  it("🔴 検出器の前提: データ層の外に D1 の呼び出しを置くと見つかる(別名で呼んでも)", () => {
    const dir = mkdtempSync(path.join(ROOT, ".tmp-boundary-"));
    try {
      mkdirSync(path.join(dir, "src"), { recursive: true });
      const file = path.join(dir, "src", "leak.ts");
      writeFileSync(
        file,
        `import type { D1Database } from "@cloudflare/workers-types";
         export async function leak(db: D1Database) {
           const stmt = db.prepare("select * from sites");
           const again = db;
           await again.batch([stmt]);
           return stmt.all();
         }
         export function notD1(r: RegExp) { return r.exec("x"); }`,
      );
      const sites = d1CallSites(dir, [path.resolve(file)]);
      expect(sites.map((s) => s.method).sort()).toEqual(["all", "batch", "prepare"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⚠【限界】any に落とした値からの呼び出しは見えない", () => {
    const dir = mkdtempSync(path.join(ROOT, ".tmp-boundary-"));
    try {
      const file = path.join(dir, "any.ts");
      writeFileSync(file, `export function f(db: any) { return db.prepare("select 1"); }`);
      expect(d1CallSites(dir, [path.resolve(file)])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
