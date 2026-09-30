// @vitest-environment node
//
// 🔴 **D1 の値に触ってよいのは `src/lib/data/` の中だけ**(所有者の分離の規則④)。
//   データ層の外で D1 に触れれば、所有者の条件を入れ忘れた SQL がそのまま通る。
//
// 🔴🔴 **判定は「呼び出しの形」ではなく「値の型」**(Codex #4 Blocker 2)。
//   前の版は `db.prepare(...)` の形(呼び出し先が直接のプロパティ参照)だけを数えていたので、
//   `const { prepare } = db` / `db["prepare"](...)` / `db.prepare.bind(db)` で抜けられた。
//   → いまは **`src/` のデータ層の外にある識別子のうち、型が D1 のもの**(D1 の値・D1 のメソッド・
//     それらを含む合併型)を**1つでも**見つけたら落とす。参照・分割代入・添字・引数渡しの区別をしない。
//   ⚠ 型の位置(型注釈・import type)は数えない。Worker は D1 を「バインドの入れ物」ごと渡すので、D1 の値に触らない。
// ⚠ 限界(【限界】の it で固定): **一度も D1 の型を持たずに `any` から取り出した値**は見えない
//   (例: `(env as any).DB.prepare(...)` —— `env` も `.DB` も型が D1 ではない)。
//
// 同じ束で、**データ層の SQL に REPLACE 系の構文が無いこと**も見る(Codex #4 Blocker 1。DB の守りが届かない分)。
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join("src", "lib", "data") + path.sep;
const D1_NAMES = new Set(["D1Database", "D1PreparedStatement", "D1DatabaseSession", "D1Result", "D1ExecResult"]);

function program(files: string[]): ts.Program {
  return ts.createProgram(files, {
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
}

function declaredInD1(symbol: ts.Symbol | undefined): boolean {
  if (symbol === undefined) return false;
  if (D1_NAMES.has(symbol.getName())) return true;
  // メソッド(`prepare` など)は、宣言の親(クラス・インターフェース)の名前で見る
  return (symbol.declarations ?? []).some((decl) => {
    const parent = decl.parent;
    return (
      (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) &&
      parent.name !== undefined &&
      D1_NAMES.has(parent.name.text)
    );
  });
}

function isD1Type(type: ts.Type): boolean {
  if (type.isUnion() || type.isIntersection()) return type.types.some(isD1Type);
  return declaredInD1(type.aliasSymbol) || declaredInD1(type.getSymbol());
}

function insideTypeOrImport(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isTypeNode(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return true;
    if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return true;
  }
  return false;
}

type Site = { file: string; line: number; text: string };

/** `files` の中で、型が D1 の識別子を返す。 */
function d1References(root: string, files: string[]): Site[] {
  const prog = program(files);
  const checker = prog.getTypeChecker();
  const found: Site[] = [];
  for (const source of prog.getSourceFiles()) {
    if (!files.includes(path.resolve(source.fileName))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !insideTypeOrImport(node) && isD1Type(checker.getTypeAtLocation(node))) {
        found.push({
          file: path.relative(root, source.fileName),
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: node.text,
        });
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

function withFixture<T>(source: string, run: (file: string, dir: string) => T): T {
  const dir = mkdtempSync(path.join(ROOT, ".tmp-boundary-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    const file = path.join(dir, "src", "leak.ts");
    writeFileSync(file, source);
    return run(path.resolve(file), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("D1 の値に触る場所", () => {
  it("🔴 src/ のうち、型が D1 の値に触っているのは src/lib/data/ だけ", () => {
    const sites = d1References(ROOT, sourceFiles(path.join(ROOT, "src")));
    expect(sites.length, "データ層の中でも1つも見つからない = 型で見分けられていない").toBeGreaterThan(0);
    expect(sites.filter((site) => !site.file.startsWith(DATA_DIR))).toEqual([]);
  });

  it.each([
    ["直接の呼び出し", `db.prepare("select 1");`],
    ["分割代入", `const { prepare } = db; prepare("select 1");`],
    ["添字アクセス", `db["prepare"]("select 1");`],
    ["bind した別名", `const run = db.prepare.bind(db); run("select 1");`],
    ["変数への別名", `const again = db; void again;`],
    ["データ層の外の関数への引数渡し", `function elsewhere(x: unknown) { return x; } elsewhere(db);`],
    ["バインドの入れ物から取り出す", `const fromEnv = env.DB; void fromEnv;`],
  ])("🔴 検出器の前提: %s を見つける", (_label, body) => {
    const sites = withFixture(
      `import type { D1Database } from "@cloudflare/workers-types";\nexport function leak(db: D1Database, env: { DB?: D1Database }) {\n${body}\n}\n`,
      (file, dir) => d1References(dir, [file]),
    );
    // 本体は3行目。引数の宣言(2行目)ではなく、本体の中で見つかっていること
    expect(sites.filter((s) => s.line === 3).length, body).toBeGreaterThan(0);
  });

  it("✅ 検出器の前提: D1 に関係ない同名のメソッド(RegExp.exec)と、型の位置は数えない", () => {
    const sites = withFixture(
      `import type { D1Database } from "@cloudflare/workers-types";
       export type Env = { DB?: D1Database };
       export function notD1(r: RegExp) { return r.exec("x"); }`,
      (file, dir) => d1References(dir, [file]),
    );
    expect(sites).toEqual([]);
  });

  it("⚠【限界】any に落とした値からの呼び出しは見えない", () => {
    const sites = withFixture(`export function f(db: any) { return db.prepare("select 1"); }`, (file, dir) =>
      d1References(dir, [file]),
    );
    expect(sites).toEqual([]);
  });
});

/*
  🔴 **データ層の SQL に、既存の行を消して入れ替える構文を書かない**(Codex #4 Blocker 1)。
    DB 側は一意なキーごとに BEFORE トリガで REPLACE を断っているが(tests/d1-replace.test.ts)、
    **一意なキーを足してトリガを足し忘れた日**に備え、使う側からも構文を締め出す。
    ⚠ 見ているのは `src/lib/data/` の**文字列・テンプレートの字面**。組み立てた文字列(`"re" + "place"`)は見えない。
*/
const FORBIDDEN_SQL = [/\bor\s+replace\b/i, /\breplace\s+into\b/i, /\bdo\s+update\b/i, /\bor\s+(ignore|rollback|fail|abort)\b/i];

function sqlFragments(files: string[]): Site[] {
  const out: Site[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? "", ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        out.push({
          file: path.relative(ROOT, file),
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: node.text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

describe("データ層の SQL の構文", () => {
  it("🔴 REPLACE・UPDATE OR REPLACE・UPSERT(DO UPDATE)・OR IGNORE などの衝突の解決を書いていない", () => {
    const fragments = sqlFragments(sourceFiles(path.join(ROOT, "src", "lib", "data")));
    expect(fragments.some((f) => /\bselect\b/i.test(f.text)), "SQL の字面が1つも見つからない = 何も見ていない").toBe(true);
    expect(fragments.filter((f) => FORBIDDEN_SQL.some((re) => re.test(f.text)))).toEqual([]);
  });

  it("✅ 前提: 禁止の形を書けば見つかる / `on conflict ... do nothing` は許す", () => {
    for (const bad of ["insert or replace into sites", "REPLACE INTO sites", "update or replace popups", "on conflict (id) do update set x = 1"]) {
      expect(FORBIDDEN_SQL.some((re) => re.test(bad)), bad).toBe(true);
    }
    expect(FORBIDDEN_SQL.some((re) => re.test("on conflict (id) do nothing")), "do nothing を禁止してしまった").toBe(false);
    expect(FORBIDDEN_SQL.some((re) => re.test("select replace(name, 'a', 'b')")), "文字列関数 replace() を禁止してしまった").toBe(false);
  });
});
