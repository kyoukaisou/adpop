// @vitest-environment node
//
// 🔴 **マイグレーションは「追加だけ」**(security 監査 M9・設計 改訂 v2 5 章)。
//   字面の正規表現ではなく、**スキーマの差分で**判定する:
//     0001..N-1 を当てた D1 の `sqlite_master`(表・索引・トリガとその SQL)と、N を当てた後を比べ、
//     **前にあったものが同じ SQL のまま全部残っている**ことを要求する。
//     → `DROP` も「中身を弱くして同じ名前で作り直す」も、ここで落ちる(名前だけを見る検査では通っていた)。
//   変えてよいのは、N のファイルの先頭に `-- adpop:allow-destructive <名前> <理由>` で**名前を名指し**したものだけ。
//   ⚠ スキーマの差分は**行の書き換え**(既存の行の UPDATE / DELETE / REPLACE)を見ない。それは下の字面の検査(補助)が見る。
//   ⚠ 適用は本番と同じ `wrangler d1 migrations apply --local`。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "db/migrations");
const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const FILES = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type SchemaObject = { type: string; name: string; sql: string };

/** 一時のディレクトリにマイグレーションを並べ、`wrangler d1 migrations apply --local` で当てる。 */
function workspace(): { dir: string; add: (file: string, content?: string) => void; apply: () => { ok: boolean; output: string } } {
  const dir = mkdtempSync(path.join(tmpdir(), "adpop-mig-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "m"));
  writeFileSync(path.join(dir, "w.js"), 'export default { fetch() { return new Response("") } }');
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "migration-check",
      main: "w.js",
      compatibility_date: "2026-09-30",
      d1_databases: [{ binding: "DB", database_name: "check", database_id: "00000000-0000-4000-8000-0000000000aa", migrations_dir: "m" }],
    }),
  );
  return {
    dir,
    add: (file, content) =>
      content === undefined ? cpSync(path.join(MIGRATIONS, file), path.join(dir, "m", file)) : writeFileSync(path.join(dir, "m", file), content),
    apply: () => {
      try {
        const output = execFileSync(
          process.execPath,
          [WRANGLER, "d1", "migrations", "apply", "check", "--local", "--persist-to", path.join(dir, "p"), "-c", path.join(dir, "wrangler.jsonc")],
          { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
        ).toString();
        return { ok: true, output };
      } catch (error) {
        return { ok: false, output: String((error as { stdout?: Buffer }).stdout ?? error) };
      }
    },
  };
}

async function query<T>(dir: string, sql: string): Promise<T[]> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(dir, "wrangler.jsonc"),
    persist: { path: path.join(dir, "p", "v3") },
  });
  try {
    return (await proxy.env.DB.prepare(sql).all<T>()).results;
  } finally {
    await proxy.dispose();
  }
}

const schemaOf = (dir: string) =>
  query<SchemaObject>(
    dir,
    `select type, name, coalesce(sql, '') as sql from sqlite_master
     where name not like 'sqlite_%' and name not like '\\_cf\\_%' escape '\\' and name <> 'd1_migrations'
     order by type, name`,
  );

function allowed(content: string): Set<string> {
  return new Set([...content.matchAll(/^--\s*adpop:allow-destructive\s+(\S+)\s+\S+/gm)].map((m) => m[1]));
}

/** 前にあったもので、後で消えた・SQL が変わったもの(名指しの許可を除く)。 */
function removedOrChanged(before: SchemaObject[], after: SchemaObject[], allow: Set<string>): string[] {
  const now = new Map(after.map((o) => [`${o.type}:${o.name}`, o.sql]));
  return before
    .filter((o) => now.get(`${o.type}:${o.name}`) !== o.sql && !allow.has(o.name))
    .map((o) => `${o.type} ${o.name}`);
}

describe("マイグレーションは追加だけ(スキーマの差分)", () => {
  it.each(FILES.slice(1).map((file, i) => [file, i + 1] as const))(
    "🔴 %s を当てても、それより前のスキーマが同じ SQL のまま残る",
    async (file, index) => {
      const ws = workspace();
      for (const earlier of FILES.slice(0, index)) ws.add(earlier);
      expect(ws.apply().ok).toBe(true);
      const before = await schemaOf(ws.dir);
      expect(before.length, "前のスキーマが空 = 何も比べていない").toBeGreaterThan(10);
      ws.add(file);
      const applied = ws.apply();
      expect(applied.ok, applied.output).toBe(true);
      const after = await schemaOf(ws.dir);
      expect(removedOrChanged(before, after, allowed(readFileSync(path.join(MIGRATIONS, file), "utf8")))).toEqual([]);
    },
  );

  it("🔴 検出器の前提: トリガの中身を弱くして同じ名前で作り直すと見つかる / 名指しすれば通る", async () => {
    const ws = workspace();
    ws.add(FILES[0]);
    expect(ws.apply().ok).toBe(true);
    const before = await schemaOf(ws.dir);
    const weaken = `drop trigger sites_limit;
create trigger sites_limit before insert on sites when 0 begin select raise(abort, 'adpop:limit:sites'); end;`;
    ws.add("9001_weaken.sql", weaken);
    expect(ws.apply().ok).toBe(true);
    const after = await schemaOf(ws.dir);
    expect(removedOrChanged(before, after, allowed(weaken))).toEqual(["trigger sites_limit"]);
    expect(removedOrChanged(before, after, allowed(`-- adpop:allow-destructive sites_limit 検査の前提\n${weaken}`))).toEqual([]);
  });
});

/*
  補助: 既存の行を書き換える文(スキーマの差分では見えない)。0002 以降に現れたら落とす。
  ⚠ 字面なので `/* *\/` の中に書かれた文や、組み立てた文は見えない(限界)。
*/
const ROW_REWRITES = [/^\s*update\s/im, /^\s*delete\s/im, /^\s*replace\s/im, /\binsert\s+or\s+replace\b/i, /^\s*pragma\s/im];

describe("既存の行を書き換える文(補助・字面)", () => {
  it.each(FILES.slice(1))("🔴 %s に既存の行を書き換える文が無い", (file) => {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    // トリガの本体(begin ... end)の中の文は「その時に起きる」もので、適用時の書き換えではない
    const outsideTriggers = sql.replace(/\bbegin\b[\s\S]*?\bend\s*;/gi, "");
    expect(ROW_REWRITES.filter((re) => re.test(outsideTriggers)).map(String)).toEqual([]);
  });
});

/*
  🔴 **`wrangler d1 migrations apply --remote` の落とし穴**(2026-10-05 実際に本番適用で踏んだ・workers-sdk #15314)。
  `--remote` は migration ファイルを**分割せず丸ごと1本の SQL として D1 の `/query` に送る**(`buildMigrationQuery`)。
  分割は D1 のサーバー側がやるが、**トリガ本体の開始トークン `BEGIN` を大文字のみでしか認識しない**
  (`END` の大文字小文字は無関係。CRLF も壊れる要因だが、このリポジトリの行末は LF で確認済み)。
  → 小文字 `begin` を使うと、ローカル(Miniflare。SQLite は大文字小文字を区別しない)では通るのに、
    `--remote` だけ `incomplete input: SQLITE_ERROR [code: 7500]` で全体が失敗する(ローカルでは再現しない)。
  ⚠ ローカル実行では検出できないので、ここは**字面の検査**で止める。D1 がサーバー側で直すまでは必須。
*/
/**
 * 行コメント(`--`)・ブロックコメント(`/* *\/`)・文字列リテラル(`'…'`・`''`エスケープ)・
 * 引用識別子(`"…"`・`""`エスケープ)の**中身**を空白に置き換える(構文上の文字だけ元のまま残す)。
 * ⚠ **除外するのは上の4種類だけ**。SQLite は識別子の引用に `[…]` や `` `…` `` も使え、
 *   `$` を含む識別子も書ける(未引用のまま)。これらの中の `begin` は除外されず、
 *   **誤って検出される**(レビュー指摘・設計の決定)。これは**安全側**(検出しすぎて止まる)で、
 *   リモートで壊れる書き方を見逃す側ではないため、このままでよいとした。
 *   ⚠ 今のマイグレーションにこの形の識別子は無い(確認済み)。将来そうした名前が要るなら、ここを直す。
 */
function stripSqlCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      while (i < n && sql[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out += " ";
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += "  ";
            i += 2;
            continue;
          }
          out += " ";
          i++;
          break;
        }
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 構文上の `begin`(大文字小文字を問わず)のうち、厳密に `BEGIN` でないものを拾う。 */
function nonUppercaseBegins(sql: string): string[] {
  const stripped = stripSqlCommentsAndStrings(sql);
  return [...stripped.matchAll(/\bbegin\b/gi)].map((m) => m[0]).filter((word) => word !== "BEGIN");
}

describe("stripSqlCommentsAndStrings / nonUppercaseBegins(字面検査の中身)", () => {
  it.each(["begin", "Begin", "bEgIn"])("🔴 構文上の %s は検出する", (word) => {
    expect(nonUppercaseBegins(`create trigger t before insert on t\n${word}\n  select raise(abort, 'x');\nend;`)).toEqual([word]);
  });

  it.each([
    ["大文字の BEGIN だけなら検出しない", "create trigger t before insert on t\nBEGIN\n  select raise(abort, 'x');\nend;"],
    ["行コメントの中の begin は検出しない", "-- begin\ncreate trigger t before insert on t\nBEGIN\n  select 1;\nend;"],
    ["単一引用文字列の中の begin は検出しない", "create table t (a text default 'begin');"],
    ["二重引用識別子の中の begin は検出しない", 'create table "begin" (a text);'],
    ["ブロックコメントの中の begin は検出しない", "/* begin */\ncreate trigger t before insert on t\nBEGIN\n  select 1;\nend;"],
  ] as const)("✅ %s", (_label, sql) => {
    expect(nonUppercaseBegins(sql)).toEqual([]);
  });
});

describe("CREATE TRIGGER の BEGIN は大文字(D1 remote splitter の既知の穴・workers-sdk #15314)", () => {
  it.each(FILES)("🔴 %s のトリガ本体が小文字/混在の begin で始まっていない", (file) => {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    expect(nonUppercaseBegins(sql)).toEqual([]);
  });
});

describe("適用の単位(実測)", () => {
  it("✅ ローカルでは、途中で落ちたマイグレーションのファイルは丸ごと戻る(作った表も入れた行も残らない)", async () => {
    const ws = workspace();
    ws.add("0001_a.sql", "create table a (id integer primary key);");
    expect(ws.apply().ok).toBe(true);
    ws.add("0002_b.sql", "create table b (id integer primary key);\ninsert into a (id) values (1);\ninsert into nope values (1);");
    expect(ws.apply().ok).toBe(false);
    const tables = await query<{ name: string }>(ws.dir, "select name from sqlite_master where type = 'table' and name in ('a', 'b')");
    expect(tables.map((t) => t.name)).toEqual(["a"]);
    expect(await query<{ c: number }>(ws.dir, "select count(*) as c from a")).toEqual([{ c: 0 }]);
    expect((await query<{ name: string }>(ws.dir, "select name from d1_migrations")).map((r) => r.name)).toEqual(["0001_a.sql"]);
  });
});
