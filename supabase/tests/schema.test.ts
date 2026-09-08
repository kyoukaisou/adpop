// @vitest-environment node
//
// スキーマ / RLS / 権限の回帰テスト。
// PGlite(WASM の PostgreSQL)に `supabase/migrations/*.sql` を順に適用し、
// **「いまそうなっている状態」を実際の SQL で測る**。Docker も Supabase の認証情報も要らないので CI で回る。
//
// 🔴 **この束がいちばん守りたいもの**(要件書 §5-3 / [[SaaS開発ナレッジ]] の型):
//   ① **Supabase の既定privilege で `anon` が public スキーマの全表・全関数に触れる**
//      → マイグレーションは1度しか流れないので、**書いた SQL ではなく実効値を毎 PR 測る**
//   ② **RLS ポリシーを `to authenticated` で書いても、GRANT で塞いでいなければ意味がない**
//      → 表ごとに「anon から見えない・書けない」を実測する
//   ③ **RLS の拒否は UPDATE / DELETE では「0件成功」**
//      → 期待値はエラーではなく**行数**で書く
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationsMissingGuard, GUARD_CALL } from "../../scripts/migration-guard.mjs";
import { TABLES as POSTGREST_TABLES } from "../../scripts/postgrest-expectations.mjs";

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

/** 業務テーブル。表を足したらここにも足す(網羅の検査が自動で効く)。 */
const TABLES = ["sites", "popups", "popup_triggers", "variants", "chatbot_nodes", "events"] as const;

/**
 * authenticated に配ってある DML。**ここが「配ったつもり」の宣言**で、
 * 実効値と突き合わせる(片方だけ変えたら落ちる)。
 */
const GRANTED_DML: Record<(typeof TABLES)[number], readonly string[]> = {
  sites: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  popups: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  variants: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  // 行は定義トリガが作り、ポップの削除でだけ消える(要件書 §6 の申し送り1)
  popup_triggers: ["SELECT", "UPDATE"],
  // 🕐 v1.1。v1 では1行も書かない(要件書 §3 除外13)
  chatbot_nodes: ["SELECT"],
  // 投入は PR2 の関数経由(要件書 §5-3)
  events: ["SELECT"],
};

const ALL_DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/**
 * Supabase 側が用意しているもののスタブ(本番では Supabase が提供する)。
 * ⚠ ここを作らないと、マイグレーションの `auth.uid()` も `references auth.users` も流れない。
 */
const AUTH_STUB = `
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create role anon;
  create role authenticated;
  create role service_role nobypassrls;
  create role authenticator noinherit login password 'postgres';
  grant anon, authenticated, service_role to authenticator;
  grant usage on schema auth to anon, authenticated, service_role;
  insert into auth.users (id, email) values
    ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test');
`;

/**
 * 🔴 **マイグレーションを流す前に、プラットフォーム側が置いた状態を再現する。**
 *   再現しないと「**剥がせているか**」ではなく「**最初から無いか**」を測ることになり、
 *   検査がまるごと空回りする([[NKARTE]] 0021 で分かった型)。
 *
 * ⚠ 開始ACLは環境で違う(実測値は [[SaaS開発ナレッジ]])。**両方から流して同じ終点に着くこと**でしか
 *   「配らないに倒した」ことは言えないので、2種類とも回す。
 */
type StartAcl = { name: string; tables: string; sequences: string; functions: string };

const START_ACLS: StartAcl[] = [
  // 素の supabase/postgres イメージ相当(業務3ロールに全部配る)
  { name: "supabaseImage", tables: "all", sequences: "all", functions: "all" },
  // supabase CLI が起動するローカルスタック相当
  { name: "supabaseCli", tables: "truncate, references, trigger, maintain", sequences: "update", functions: "" },
];

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

async function applyStartAcl(db: PGlite, acl: StartAcl): Promise<void> {
  // Supabase は public スキーマそのものも業務3ロールへ配っている
  await db.exec(`grant all on schema public to anon, authenticated, service_role;`);
  for (const [kind, privileges] of [
    ["tables", acl.tables],
    ["sequences", acl.sequences],
    ["functions", acl.functions],
  ] as const) {
    if (privileges === "") continue;
    await db.exec(`
      do $$
      declare
        privs text := $q$${privileges}$q$;
      begin
        -- MAINTAIN は PG17 以降にしか無い
        if current_setting('server_version_num')::int < 170000 then
          privs := replace(privs, ', maintain', '');
        end if;
        execute format(
          'alter default privileges in schema public grant %s on ${kind} to anon, authenticated, service_role',
          privs);
      end $$;
    `);
  }
}

async function applyMigrations(db: PGlite): Promise<void> {
  for (const file of MIGRATION_FILES) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
}

async function createMigratedDb(acl: StartAcl): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(AUTH_STUB);
  await applyStartAcl(db, acl);
  await applyMigrations(db);
  return db;
}

function claimsFor(uid: string): string {
  return JSON.stringify({ sub: uid, role: "authenticated" });
}

async function beginSession(db: PGlite, uid: string): Promise<void> {
  await db.exec(`set request.jwt.claims = '${claimsFor(uid)}'; set role authenticated;`);
}

async function endSession(db: PGlite): Promise<void> {
  await db.exec("reset role; reset request.jwt.claims;");
}

async function asUser(db: PGlite, uid: string, sql: string): Promise<void> {
  await beginSession(db, uid);
  try {
    await db.exec(sql);
  } finally {
    await endSession(db);
  }
}

/** 拒否されることを測る。**返すのは SQLSTATE**(文言ではない)。 */
async function sqlstateOf(db: PGlite, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
  return "";
}

/*
  ══════════════════════════════════════════════════════════════════════════
  0. 開始ACLの再現そのものが効いているか(**この束の前提**)
  ══════════════════════════════════════════════════════════════════════════
  🔴 これが無いと、下の全部が「最初から権限が無かっただけ」でも緑になる。
*/
describe("開始ACLの再現(前提の検算)", () => {
  it("マイグレーションを流す前は、新しい表に anon の権限が付く(= 既定privilege を再現できている)", async () => {
    const db = await PGlite.create();
    try {
      await db.exec(AUTH_STUB);
      await applyStartAcl(db, START_ACLS[0]);
      await db.exec("create table public.zz_before_migrations (id int);");
      const r = await db.query<{ granted: boolean }>(
        `select has_table_privilege('anon', 'public.zz_before_migrations', 'SELECT') as granted`,
      );
      expect(r.rows[0].granted, "既定privilege の再現が効いていない = 以下の検査は全部空回りする").toBe(true);
    } finally {
      await db.close();
    }
  });

  it("🔴 マイグレーションを流す前は、新しい関数を PUBLIC が実行できる(PostgreSQL 組み込みの既定)", async () => {
    /*
      🔴 **これは PGlite でも本物の PostgreSQL 17 でも同じ**(2026-09-08 実測)。
        `alter default privileges **in schema public** revoke ... on functions from public` は
        この組み込みの既定を1ミリも動かさない —— 組み込みの既定は**グローバル側**に在るため。
        0001 がグローバル側も落としていることを、下の「関数を1本も実行できない」が測る。
    */
    const db = await PGlite.create();
    try {
      await db.exec(AUTH_STUB);
      await applyStartAcl(db, START_ACLS[1]); // functions は grant していない開始ACL
      await db.exec(`create function public.zz_before_fn() returns int language sql as 'select 1';`);
      const r = await db.query<{ granted: boolean }>(
        `select has_function_privilege('public', 'public.zz_before_fn()', 'EXECUTE') as granted`,
      );
      expect(r.rows[0].granted).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("マイグレーションを流す前は、anon が public スキーマの USAGE を持つ", async () => {
    const db = await PGlite.create();
    try {
      await db.exec(AUTH_STUB);
      await applyStartAcl(db, START_ACLS[0]);
      const r = await db.query<{ granted: boolean }>(
        `select has_schema_privilege('anon', 'public', 'USAGE') as granted`,
      );
      expect(r.rows[0].granted).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe.each(START_ACLS)("開始ACL = $name", (acl) => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb(acl);
  });

  afterAll(async () => {
    await db?.close();
  });

  /*
    ────────────────────────────────────────────────────────────────────
    1. anon / service_role / PUBLIC には何も配らない(要件書 §5-3)
    ────────────────────────────────────────────────────────────────────
  */
  describe("anon / service_role / PUBLIC の権限", () => {
    it.each(TABLES)("%s に対して anon は8種の権限を1つも持たない(列単位も含む)", async (table) => {
      const r = await db.query<{ table_level: boolean; column_level: boolean }>(
        `select
           bool_or(has_table_privilege('anon', $1, p))                                  as table_level,
           bool_or(p in ('SELECT','INSERT','UPDATE','REFERENCES')
                   and has_any_column_privilege('anon', $1::regclass, p))               as column_level
         from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) as p`,
        [`public.${table}`],
      );
      expect(r.rows[0].table_level, `anon が ${table} に表単位の権限を持っている`).toBe(false);
      // ⚠ `has_table_privilege` は列単位の grant を映さない([[SaaS開発ナレッジ]] 2026-09-08-07)
      expect(r.rows[0].column_level, `anon が ${table} に列単位の権限を持っている`).toBe(false);
    });

    it.each(TABLES)("%s に対して service_role と PUBLIC も権限を持たない", async (table) => {
      const r = await db.query<{ grantee: string }>(
        `select ro.g as grantee
         from (values ('service_role'), ('public')) ro(g)
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) as p
         where has_table_privilege(ro.g, $1, p)`,
        [`public.${table}`],
      );
      expect(r.rows).toEqual([]);
    });

    it("anon は public スキーマの USAGE を持たない(= 入口が無い)", async () => {
      const r = await db.query<{ usage: boolean; create: boolean }>(
        `select has_schema_privilege('anon', 'public', 'USAGE') as usage,
                has_schema_privilege('anon', 'public', 'CREATE') as create`,
      );
      expect(r.rows[0].usage).toBe(false);
      expect(r.rows[0].create).toBe(false);
    });

    it("public スキーマの CREATE は業務ロールの誰も持たない", async () => {
      const r = await db.query<{ role: string }>(
        `select ro.g as role
         from (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
         where has_schema_privilege(ro.g, 'public', 'CREATE')`,
      );
      expect(r.rows).toEqual([]);
    });

    it("public スキーマの関数を anon / service_role / PUBLIC は1本も実行できない", async () => {
      // ⚠ PR2 で配信用の関数を1本だけ anon へ開ける。そのときは
      //   `adpop_anon_callable_functions()` に署名を足し、この期待値も同時に動かす。
      const r = await db.query<{ fn: string; grantee: string }>(
        `select p.oid::regprocedure::text as fn, ro.g as grantee
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         cross join (values ('anon'), ('service_role'), ('public')) ro(g)
         where n.nspname = 'public' and has_function_privilege(ro.g, p.oid, 'EXECUTE')`,
      );
      expect(r.rows).toEqual([]);
    });

    it("連番(identity 列の裏側を含む)にも anon / service_role / PUBLIC の権限が無い", async () => {
      const r = await db.query<{ seq: string; grantee: string }>(
        `select c.oid::regclass::text as seq, ro.g as grantee
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         cross join (values ('anon'), ('service_role'), ('public')) ro(g)
         cross join unnest(array['USAGE','SELECT','UPDATE']) as p
         where n.nspname = 'public' and c.relkind = 'S' and has_sequence_privilege(ro.g, c.oid, p)`,
      );
      expect(r.rows).toEqual([]);
    });

    it("これから作られる表・連番・関数にも権限が配られない", async () => {
      await db.exec(`
        create table public.zz_after_migrations (id int);
        create sequence public.zz_after_migrations_seq;
        create function public.zz_after_migrations_fn() returns int language sql as 'select 1';
      `);
      try {
        const r = await db.query<{ kind: string; grantee: string }>(
          `select 'table' as kind, ro.g as grantee
             from (values ('anon'),('authenticated'),('service_role'),('public')) ro(g)
             cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
            where has_table_privilege(ro.g, 'public.zz_after_migrations', p)
           union all
           select 'sequence', ro.g
             from (values ('anon'),('authenticated'),('service_role'),('public')) ro(g)
             cross join unnest(array['USAGE','SELECT','UPDATE']) p
            where has_sequence_privilege(ro.g, 'public.zz_after_migrations_seq', p)
           union all
           select 'function', ro.g
             from (values ('anon'),('authenticated'),('service_role'),('public')) ro(g)
            where has_function_privilege(ro.g, 'public.zz_after_migrations_fn()', 'EXECUTE')`,
        );
        expect(r.rows).toEqual([]);
      } finally {
        await db.exec(`
          drop function public.zz_after_migrations_fn();
          drop sequence public.zz_after_migrations_seq;
          drop table public.zz_after_migrations;
        `);
      }
    });
  });

  /*
    ────────────────────────────────────────────────────────────────────
    2. authenticated に配った権限は、宣言どおりで、それ以上でも以下でもない
    ────────────────────────────────────────────────────────────────────
  */
  describe("authenticated の権限", () => {
    it.each(TABLES)("%s の DML 権限が宣言と一致する", async (table) => {
      const r = await db.query<{ priv: string }>(
        `select p as priv
         from unnest($2::text[]) as p
         where has_table_privilege('authenticated', $1, p)
         order by 1`,
        [`public.${table}`, [...ALL_DML]],
      );
      expect(r.rows.map((row) => row.priv).sort()).toEqual([...GRANTED_DML[table]].sort());
    });

    it.each(TABLES)("%s に DML の外側(TRUNCATE / REFERENCES / TRIGGER / MAINTAIN)を持たない", async (table) => {
      // 🔴 **RLS は TRUNCATE に適用されない。** ここが付いていたら、行の分離は無いのと同じ。
      const r = await db.query<{ priv: string }>(
        `select p as priv
         from unnest(array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) as p
         where has_table_privilege('authenticated', $1, p)`,
        [`public.${table}`],
      );
      expect(r.rows).toEqual([]);
    });
  });

  /*
    ────────────────────────────────────────────────────────────────────
    3. RLS(有効化とポリシーの形)
    ────────────────────────────────────────────────────────────────────
  */
  describe("RLS", () => {
    it.each(TABLES)("%s は RLS が有効", async (table) => {
      const r = await db.query<{ enabled: boolean }>(
        `select relrowsecurity as enabled from pg_class where oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(r.rows[0].enabled).toBe(true);
    });

    it.each(TABLES)("%s のポリシーは、配ってある権限と同じ集合しか無い", async (table) => {
      /*
        🔴 **配っていない操作のポリシーを作らない**のが要点。
          将来だれかが grant を1文足しても、ポリシーが無ければ通らない
          (迂回には「権限」と「ポリシー」の2つが要る)。
      */
      const r = await db.query<{ cmd: string }>(
        `select case polcmd
                  when 'r' then 'SELECT' when 'a' then 'INSERT'
                  when 'w' then 'UPDATE' when 'd' then 'DELETE'
                  else polcmd::text end as cmd
         from pg_policy where polrelid = $1::regclass`,
        [`public.${table}`],
      );
      expect(r.rows.map((row) => row.cmd).sort()).toEqual([...GRANTED_DML[table]].sort());
    });

    it.each(TABLES)("%s のポリシーは authenticated だけに向いている", async (table) => {
      const r = await db.query<{ roles: string[] }>(
        `select array(select rolname from pg_roles where oid = any(polroles) order by 1) as roles
         from pg_policy where polrelid = $1::regclass`,
        [`public.${table}`],
      );
      for (const row of r.rows) expect(row.roles).toEqual(["authenticated"]);
    });
  });

  /*
    ────────────────────────────────────────────────────────────────────
    4. 行の分離(他人のデータに触れない)
    ────────────────────────────────────────────────────────────────────
  */
  describe("行の分離", () => {
    beforeAll(async () => {
      await asUser(
        db,
        USER_A,
        `insert into public.sites (owner_id, name, allowed_origins)
           values ('${USER_A}', 'A の LP', array['https://a.example.com']);`,
      );
      await asUser(
        db,
        USER_B,
        `insert into public.sites (owner_id, name) values ('${USER_B}', 'B の LP');`,
      );
    });

    it("他人のサイトは1件も見えない", async () => {
      await beginSession(db, USER_B);
      try {
        const r = await db.query<{ name: string }>(`select name from public.sites`);
        expect(r.rows.map((row) => row.name)).toEqual(["B の LP"]);
      } finally {
        await endSession(db);
      }
    });

    it("🔴 他人の行の UPDATE は**エラーではなく0件成功**になる(行数で判定する)", async () => {
      await beginSession(db, USER_B);
      let affected: number | undefined;
      try {
        const r = await db.query(`update public.sites set name = '乗っ取り' where name = 'A の LP'`);
        affected = r.affectedRows;
      } finally {
        await endSession(db);
      }
      // ⚠ ここを「例外が出ること」で書くと、**永遠に緑にならない**(RLS は黙って0件にする)
      expect(affected, "他人の行を更新できてしまった").toBe(0);

      const after = await db.query<{ name: string }>(
        `select name from public.sites where owner_id = '${USER_A}'`,
      );
      expect(after.rows.map((row) => row.name)).toEqual(["A の LP"]);
    });

    it("🔴 他人の行の DELETE も0件成功になる", async () => {
      await beginSession(db, USER_B);
      let affected: number | undefined;
      try {
        const r = await db.query(`delete from public.sites where name = 'A の LP'`);
        affected = r.affectedRows;
      } finally {
        await endSession(db);
      }
      expect(affected, "他人の行を消せてしまった").toBe(0);
      const after = await db.query<{ c: number }>(
        `select count(*)::int as c from public.sites where owner_id = '${USER_A}'`,
      );
      expect(after.rows[0].c).toBe(1);
    });

    it("他人の owner_id で INSERT すると拒否される(42501)", async () => {
      await beginSession(db, USER_B);
      const code = await sqlstateOf(db, () =>
        db.query(`insert into public.sites (owner_id, name) values ('${USER_A}', 'なりすまし')`),
      );
      await endSession(db);
      expect(code).toBe("42501");
    });

    it("🔴 自分の owner_id のまま、他人のサイトにポップをぶら下げられない(複合外部キー)", async () => {
      const site = await db.query<{ id: string }>(
        `select id from public.sites where owner_id = '${USER_A}'`,
      );
      await beginSession(db, USER_B);
      const code = await sqlstateOf(db, () =>
        db.query(
          `insert into public.popups (owner_id, site_id, name) values ('${USER_B}', $1, '横取り')`,
          [site.rows[0].id],
        ),
      );
      await endSession(db);
      // 23503 = foreign_key_violation。⚠ RLS は owner_id しか見ないので、ここは FK が守っている
      expect(code, "他人のサイトに自分のポップをぶら下げられた").toBe("23503");
    });

    it("anon からは1つの表も読めない(42501)", async () => {
      for (const table of TABLES) {
        await db.exec("set role anon;");
        const code = await sqlstateOf(db, () => db.query(`select * from public.${table} limit 1`));
        await db.exec("reset role;");
        expect(code, `anon が ${table} を読めてしまった`).toBe("42501");
      }
    });
  });

  /*
    ────────────────────────────────────────────────────────────────────
    4-2. 行の分離を **6表すべて** で測る(Codex 1巡目 High・両モデル)
    ────────────────────────────────────────────────────────────────────
    🔴 sites だけを測っていたので、**`variants_select` を `using (true)` にしても1件も落ちなかった。**
      「守りが在る」ことと「その表を守っている」ことは別 —— **表ごとに撃つ。**
    ⚠ 測る操作は**配ってある DML の分だけ**(配っていない操作は、そもそも 42501 で
      別の検査が見ている)。
  */
  describe("行の分離(6表すべて)", () => {
    /** 各表の「他人の行を作ろうとする INSERT」。⚠ 表ごとに形が違うので、ここだけ手で書く。 */
    const rows: Record<
      (typeof TABLES)[number],
      { ids: Record<string, string>; insertAsOther?: (otherOwner: string) => [string, unknown[]] }
    > = {
      sites: { ids: {} },
      popups: { ids: {} },
      popup_triggers: { ids: {} },
      variants: { ids: {} },
      chatbot_nodes: { ids: {} },
      events: { ids: {} },
    };

    /** owner ごとに サイト→ポップ→バリアント→ノード→イベント を1式ずつ作る。 */
    async function seedFor(owner: string, label: string): Promise<void> {
      await asUser(
        db,
        owner,
        `insert into public.sites (owner_id, name) values ('${owner}', '分離${label}');`,
      );
      const site = await db.query<{ id: string }>(
        `select id from public.sites where name = '分離${label}'`,
      );
      await asUser(
        db,
        owner,
        `insert into public.popups (owner_id, site_id, name)
           values ('${owner}', '${site.rows[0].id}', '分離${label}');`,
      );
      const popup = await db.query<{ id: string }>(
        `select id from public.popups where name = '分離${label}'`,
      );
      await asUser(
        db,
        owner,
        `insert into public.variants (owner_id, popup_id, destination_url)
           values ('${owner}', '${popup.rows[0].id}', 'https://example.com/分離${label}');`,
      );
      const variant = await db.query<{ id: string }>(
        `select id from public.variants where destination_url = 'https://example.com/分離${label}'`,
      );
      const trigger = await db.query<{ id: string }>(
        `select id from public.popup_triggers where popup_id = $1 and kind = 'back'`,
        [popup.rows[0].id],
      );
      // ⚠ chatbot_nodes と events は利用者に書き込みを配っていないので、所有者として置く
      const node = await db.query<{ id: string }>(
        `insert into public.chatbot_nodes (owner_id, variant_id, prompt) values ($1, $2, '分離${label}')
         returning id`,
        [owner, variant.rows[0].id],
      );
      const event = await db.query<{ id: string }>(
        `insert into public.events (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device)
         values ($1, $2, $3, $4, 'impression', 'back', gen_random_uuid(), 'mobile')
         returning id`,
        [owner, site.rows[0].id, popup.rows[0].id, variant.rows[0].id],
      );

      rows.sites.ids[owner] = site.rows[0].id;
      rows.popups.ids[owner] = popup.rows[0].id;
      rows.popup_triggers.ids[owner] = trigger.rows[0].id;
      rows.variants.ids[owner] = variant.rows[0].id;
      rows.chatbot_nodes.ids[owner] = node.rows[0].id;
      rows.events.ids[owner] = String(event.rows[0].id);
    }

    beforeAll(async () => {
      await seedFor(USER_A, "A");
      await seedFor(USER_B, "B");
    });

    it.each(TABLES)("%s: 他人の行は SELECT で1件も見えない", async (table) => {
      await beginSession(db, USER_B);
      try {
        const r = await db.query<{ owner_id: string }>(`select owner_id from public.${table}`);
        // 🔴 0件を「見えていない」と読ませない —— 自分の行が在ることを先に確かめる
        expect(r.rows.length, `${table} に B 自身の行が1件も無い = 何も測れていない`).toBeGreaterThan(0);
        expect(
          r.rows.filter((row) => row.owner_id !== USER_B),
          `${table} で他人の行が見えた`,
        ).toEqual([]);
      } finally {
        await endSession(db);
      }
    });

    it.each(TABLES.filter((t) => GRANTED_DML[t].includes("UPDATE")))(
      "%s: 他人の行の UPDATE は0件成功(エラーではない)",
      async (table) => {
        const targetId = rows[table].ids[USER_A];
        await beginSession(db, USER_B);
        let affected: number | undefined;
        try {
          // updated_at だけを触る(どの表にも在る列)
          const r = await db.query(
            `update public.${table} set updated_at = now() where id = $1`,
            [targetId],
          );
          affected = r.affectedRows;
        } finally {
          await endSession(db);
        }
        expect(affected, `${table} で他人の行を更新できた`).toBe(0);
      },
    );

    it.each(TABLES.filter((t) => GRANTED_DML[t].includes("DELETE")))(
      "%s: 他人の行の DELETE は0件成功",
      async (table) => {
        const targetId = rows[table].ids[USER_A];
        await beginSession(db, USER_B);
        let affected: number | undefined;
        try {
          const r = await db.query(`delete from public.${table} where id = $1`, [targetId]);
          affected = r.affectedRows;
        } finally {
          await endSession(db);
        }
        expect(affected, `${table} で他人の行を消せた`).toBe(0);
        const alive = await db.query<{ c: number }>(
          `select count(*)::int as c from public.${table} where id = $1`,
          [targetId],
        );
        expect(alive.rows[0].c).toBe(1);
      },
    );

    it.each(TABLES.filter((t) => GRANTED_DML[t].includes("INSERT")))(
      "%s: 他人の owner_id での INSERT は 42501",
      async (table) => {
        const inserts: Record<string, [string, unknown[]]> = {
          sites: [
            `insert into public.sites (owner_id, name) values ($1, 'なりすまし')`,
            [USER_A],
          ],
          popups: [
            `insert into public.popups (owner_id, site_id, name) values ($1, $2, 'なりすまし')`,
            [USER_A, rows.sites.ids[USER_A]],
          ],
          variants: [
            `insert into public.variants (owner_id, popup_id, destination_url)
             values ($1, $2, 'https://example.com/なりすまし')`,
            [USER_A, rows.popups.ids[USER_A]],
          ],
        };
        const [sql, params] = inserts[table];
        await beginSession(db, USER_B);
        const code = await sqlstateOf(db, () => db.query(sql, params));
        await endSession(db);
        expect(code, `${table} に他人の owner_id で行を作れた`).toBe("42501");
      },
    );
  });

  /*
    ────────────────────────────────────────────────────────────────────
    5. 表の形(要件書 §4-7 / §5-3 が正)
    ────────────────────────────────────────────────────────────────────
  */
  describe("表の形", () => {
    let siteId: string;
    let popupId: string;
    let variantId: string;

    beforeAll(async () => {
      await asUser(
        db,
        USER_A,
        `insert into public.sites (owner_id, name) values ('${USER_A}', '形の検査用');`,
      );
      const site = await db.query<{ id: string }>(
        `select id from public.sites where name = '形の検査用'`,
      );
      siteId = site.rows[0].id;
      await asUser(
        db,
        USER_A,
        `insert into public.popups (owner_id, site_id, name) values ('${USER_A}', '${siteId}', '形の検査用');`,
      );
      const popup = await db.query<{ id: string }>(
        `select id from public.popups where name = '形の検査用'`,
      );
      popupId = popup.rows[0].id;
      await asUser(
        db,
        USER_A,
        `insert into public.variants (owner_id, popup_id, destination_url)
           values ('${USER_A}', '${popupId}', 'https://example.com/offer');`,
      );
      const variant = await db.query<{ id: string }>(
        `select id from public.variants where popup_id = '${popupId}'`,
      );
      variantId = variant.rows[0].id;
    });

    it("サイトキーは32桁の16進で、行ごとに違う", async () => {
      const r = await db.query<{ site_key: string }>(`select site_key from public.sites`);
      const keys = r.rows.map((row) => row.site_key);
      expect(keys.length).toBeGreaterThan(1);
      for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("許可ドメインは Origin の形しか受け付けない(パス付き・http は弾く)", async () => {
      for (const bad of ["http://example.com", "https://example.com/path", "example.com", "https://例.com"]) {
        const code = await sqlstateOf(db, () =>
          db.query(`update public.sites set allowed_origins = array[$1] where id = $2`, [bad, siteId]),
        );
        expect(code, `許可ドメインとして ${bad} が通ってしまった`).toBe("23514");
      }
      // 通る形(ポート付きも許す)
      await db.exec(
        `update public.sites set allowed_origins = array['https://lp.example.com', 'https://lp.example.com:8443'] where id = '${siteId}'`,
      );
    });

    it("🔴 遷移先 URL は https 以外を保存できない(javascript: / data: / http:)", async () => {
      for (const bad of [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "http://example.com",
        "HTTPS://example.com",
        "https://example.com/ with space",
      ]) {
        const code = await sqlstateOf(db, () =>
          db.query(
            `insert into public.variants (owner_id, popup_id, destination_url) values ($1, $2, $3)`,
            [USER_A, popupId, bad],
          ),
        );
        expect(code, `遷移先として ${bad} が通ってしまった`).toBe("23514");
      }
    });

    it("🔴 ポップを作ると、6トリガの行が §4-2 の既定値で必ず揃う", async () => {
      const r = await db.query<{ kind: string; enabled: boolean; threshold: number | null }>(
        `select kind::text as kind, enabled, threshold from public.popup_triggers
         where popup_id = $1 order by kind::text`,
        [popupId],
      );
      expect(r.rows).toEqual(
        [
          { kind: "back", enabled: true, threshold: null },
          { kind: "dwell", enabled: false, threshold: 45 },
          { kind: "exit_intent", enabled: true, threshold: null },
          { kind: "idle", enabled: false, threshold: 30 },
          { kind: "scroll", enabled: false, threshold: 50 },
          { kind: "visibility", enabled: false, threshold: null },
        ].sort((a, b) => a.kind.localeCompare(b.kind)),
      );
    });

    it("利用者はトリガの行を作れない・消せない(権限が無い)", async () => {
      await beginSession(db, USER_A);
      const insertCode = await sqlstateOf(db, () =>
        db.query(
          `insert into public.popup_triggers (owner_id, popup_id, kind) values ($1, $2, 'back')`,
          [USER_A, popupId],
        ),
      );
      const deleteCode = await sqlstateOf(db, () =>
        db.query(`delete from public.popup_triggers where popup_id = $1`, [popupId]),
      );
      await endSession(db);
      expect(insertCode).toBe("42501");
      expect(deleteCode).toBe("42501");
    });

    it("トリガの閾値と ON/OFF は更新できる(管理画面がやること)", async () => {
      await beginSession(db, USER_A);
      const r = await db.query(
        `update public.popup_triggers set enabled = true, threshold = 80
         where popup_id = $1 and kind = 'scroll'`,
        [popupId],
      );
      await endSession(db);
      expect(r.affectedRows).toBe(1);
    });

    it("🕐 chatbot_nodes は v1 では書き込めない(表と読み取りだけ在る)", async () => {
      await beginSession(db, USER_A);
      const code = await sqlstateOf(db, () =>
        db.query(
          `insert into public.chatbot_nodes (owner_id, variant_id, prompt) values ($1, $2, 'どれをお探しですか')`,
          [USER_A, variantId],
        ),
      );
      /*
        ⚠ **「0件だから書けていない」とは書かない。**
          別の検査が所有者としてノードを置いているので、ここが 0 になるとは限らない。
          測るのは **①insert が 42501 で断られること ②見えるのは自分の行だけであること** の2つ。
      */
      const read = await db.query<{ owner_id: string }>(`select owner_id from public.chatbot_nodes`);
      await endSession(db);
      expect(code).toBe("42501");
      expect(read.rows.filter((row) => row.owner_id !== USER_A)).toEqual([]);
    });

    it("events は authenticated からも書けない(投入は PR2 の関数経由)", async () => {
      await beginSession(db, USER_A);
      const code = await sqlstateOf(db, () =>
        db.query(
          `insert into public.events (owner_id, site_id, popup_id, kind, device)
             values ($1, $2, $3, 'fire', 'mobile')`,
          [USER_A, siteId, popupId],
        ),
      );
      await endSession(db);
      expect(code).toBe("42501");
    });

    describe("events の形(§4-7 の定義を CHECK に落としたもの)", () => {
      const impression = "aaaaaaaa-0000-0000-0000-000000000001";

      async function insertEvent(columns: string, values: string): Promise<string> {
        return sqlstateOf(db, () =>
          db.query(`insert into public.events (${columns}) values (${values})`),
        );
      }

      const base = `owner_id, site_id, popup_id, variant_id, kind, device`;
      const baseValues = () => `'${USER_A}', '${siteId}', '${popupId}', '${variantId}'`;

      it("impression は trigger_kind と impression_id と variant_id が必須", async () => {
        expect(
          await insertEvent(base, `${baseValues()}, 'impression', 'mobile'`),
          "trigger_kind の無い impression が通った",
        ).toBe("23514");
        expect(
          await insertEvent(
            `${base}, trigger_kind`,
            `${baseValues()}, 'impression', 'mobile', 'back'`,
          ),
          "impression_id の無い impression が通った",
        ).toBe("23514");
        expect(
          await insertEvent(
            `${base}, trigger_kind, impression_id`,
            `${baseValues()}, 'impression', 'mobile', 'back', '${impression}'`,
          ),
        ).toBe("");
      });

      it("close は close_reason が必須で、他の kind には付けられない", async () => {
        expect(
          await insertEvent(
            `${base}, impression_id`,
            `${baseValues()}, 'close', 'mobile', '${impression}'`,
          ),
          "close_reason の無い close が通った",
        ).toBe("23514");
        expect(
          await insertEvent(
            `${base}, trigger_kind, impression_id, close_reason`,
            `${baseValues()}, 'impression', 'mobile', 'back', '${impression}', 'esc'`,
          ),
          "impression に close_reason が付けられた",
        ).toBe("23514");
        expect(
          await insertEvent(
            `${base}, impression_id, close_reason`,
            `${baseValues()}, 'close', 'mobile', '${impression}', 'esc'`,
          ),
        ).toBe("");
      });

      it("🔴 表示と閉じるは impression_id につき1回しか記録されない(重複排除)", async () => {
        expect(
          await insertEvent(
            `${base}, trigger_kind, impression_id`,
            `${baseValues()}, 'impression', 'mobile', 'back', '${impression}'`,
          ),
          "同じ impression_id の表示が2回入った",
        ).toBe("23505");
        expect(
          await insertEvent(
            `${base}, impression_id, close_reason`,
            `${baseValues()}, 'close', 'mobile', '${impression}', 'button'`,
          ),
          "同じ impression_id の閉じるが2回入った",
        ).toBe("23505");
      });

      it("クリックは同じ表示に何度でも記録できる(CTR はダッシュボードで畳む)", async () => {
        for (let i = 0; i < 2; i += 1) {
          expect(
            await insertEvent(
              `${base}, impression_id`,
              `${baseValues()}, 'click', 'mobile', '${impression}'`,
            ),
          ).toBe("");
        }
      });

      it("🔴 紐づく表示が無い CV も記録できる(これが無いと分母が歪む)", async () => {
        expect(
          await insertEvent(
            `owner_id, site_id, kind, device`,
            `'${USER_A}', '${siteId}', 'conversion', 'desktop'`,
          ),
        ).toBe("");
      });

      it("fire / suppressed に impression_id は付けられない(まだ表示していない)", async () => {
        expect(
          await insertEvent(
            `${base}, impression_id`,
            `${baseValues()}, 'fire', 'mobile', '${impression}'`,
          ),
        ).toBe("23514");
      });

      it("匿名IDは32桁の16進しか入らない(氏名やメールの形は弾く)", async () => {
        expect(
          await insertEvent(
            `${base}, visitor_hash`,
            `${baseValues()}, 'fire', 'mobile', 'taro@example.com'`,
          ),
        ).toBe("23514");
      });
    });
  });

  /*
    ────────────────────────────────────────────────────────────────────
    5-2. 階層の一致(Codex 1巡目 High)
    ────────────────────────────────────────────────────────────────────
    🔴 owner の一致だけを見ていると、**同じ owner の中で階層が混ざった行**が保存できる。
      ここは「落ちる例」だけでなく「**通るべき組み合わせが通ること**」も測る
      (落ちることしか測らないと、締めすぎに気づけない)。
  */
  describe("events の階層の一致", () => {
    let s1: string;
    let s2: string;
    let p1: string;
    let p2: string;
    let v1: string;
    let v2: string;

    beforeAll(async () => {
      // 同じ owner が2つのサイトを持ち、それぞれにポップとバリアントが1つずつ在る状態
      await asUser(
        db,
        USER_A,
        `insert into public.sites (owner_id, name) values ('${USER_A}', '階層S1'), ('${USER_A}', '階層S2');`,
      );
      const sites = await db.query<{ id: string; name: string }>(
        `select id, name from public.sites where name in ('階層S1','階層S2') order by name`,
      );
      [s1, s2] = sites.rows.map((row) => row.id);
      await asUser(
        db,
        USER_A,
        `insert into public.popups (owner_id, site_id, name) values
           ('${USER_A}', '${s1}', '階層P1'), ('${USER_A}', '${s2}', '階層P2');`,
      );
      const popups = await db.query<{ id: string; name: string }>(
        `select id, name from public.popups where name in ('階層P1','階層P2') order by name`,
      );
      [p1, p2] = popups.rows.map((row) => row.id);
      await asUser(
        db,
        USER_A,
        `insert into public.variants (owner_id, popup_id, destination_url) values
           ('${USER_A}', '${p1}', 'https://example.com/v1'),
           ('${USER_A}', '${p2}', 'https://example.com/v2');`,
      );
      const variants = await db.query<{ id: string; destination_url: string }>(
        `select id, destination_url from public.variants
         where destination_url in ('https://example.com/v1','https://example.com/v2')
         order by destination_url`,
      );
      [v1, v2] = variants.rows.map((row) => row.id);
    });

    const insertImpression = (site: string, popup: string, variant: string, impression: string) =>
      sqlstateOf(db, () =>
        db.query(
          `insert into public.events
             (owner_id, site_id, popup_id, variant_id, kind, trigger_kind, impression_id, device)
           values ($1, $2, $3, $4, 'impression', 'back', $5, 'mobile')`,
          [USER_A, site, popup, variant, impression],
        ),
      );

    it("✅ 階層が揃った組み合わせは通る(締めすぎていないこと)", async () => {
      expect(await insertImpression(s1, p1, v1, "bbbbbbbb-0000-0000-0000-000000000001")).toBe("");
      expect(await insertImpression(s2, p2, v2, "bbbbbbbb-0000-0000-0000-000000000002")).toBe("");
    });

    it("🔴 別サイト配下のポップを指すイベントは落ちる(23503)", async () => {
      expect(await insertImpression(s1, p2, v2, "bbbbbbbb-0000-0000-0000-000000000003")).toBe("23503");
    });

    it("🔴 別ポップ配下のバリアントを指すイベントは落ちる(23503)", async () => {
      expect(await insertImpression(s1, p1, v2, "bbbbbbbb-0000-0000-0000-000000000004")).toBe("23503");
    });

    it("🔴 popup_id を null にして階層の縛りを外せない(複合外部キーは MATCH SIMPLE)", async () => {
      /*
        ⚠ ここが要点 —— 複合外部キーは**列のどれかが null なら制約ごと素通り**する。
          `variant_id` だけ入れて `popup_id` を null にすると、
          `(variant_id, popup_id)` の FK は1つも評価されない。CHECK が塞ぐ。
      */
      const code = await sqlstateOf(db, () =>
        db.query(
          `insert into public.events (owner_id, site_id, variant_id, kind, device)
           values ($1, $2, $3, 'conversion', 'mobile')`,
          [USER_A, s1, v2],
        ),
      );
      expect(code).toBe("23514");
    });
  });

  describe("page_url に個人情報を持ち込ませない(Codex 1巡目 High)", () => {
    it("🔴 クエリ文字列・フラグメントが付いた URL は保存できない", async () => {
      const site = await db.query<{ id: string }>(
        `select id from public.sites where name = '階層S1'`,
      );
      for (const bad of [
        "https://lp.example.com/a?email=taro%40example.com",
        "https://lp.example.com/a?utm_source=x",
        "https://lp.example.com/a#section",
      ]) {
        const code = await sqlstateOf(db, () =>
          db.query(
            `insert into public.events (owner_id, site_id, kind, device, page_url)
             values ($1, $2, 'conversion', 'mobile', $3)`,
            [USER_A, site.rows[0].id, bad],
          ),
        );
        expect(code, `${bad} が保存できてしまった`).toBe("23514");
      }
    });

    it("✅ origin + path だけなら保存できる", async () => {
      const site = await db.query<{ id: string }>(
        `select id from public.sites where name = '階層S1'`,
      );
      const code = await sqlstateOf(db, () =>
        db.query(
          `insert into public.events (owner_id, site_id, kind, device, page_url)
           values ($1, $2, 'conversion', 'mobile', 'https://lp.example.com/a/b')`,
          [site.rows[0] ? USER_A : USER_A, site.rows[0].id],
        ),
      );
      expect(code).toBe("");
    });
  });

  describe("chatbot_nodes の親(🕐 v1.1 の下ごしらえ)", () => {
    /*
      ⚠ v1 は書き込み権限が1つも無いので、**表の所有者として**行を置く。
        **本番の経路を再現しているのではない**(そもそも本番の経路がまだ無い)。
    */
    it("🔴 別のバリアントのノードを親にできない(23503)", async () => {
      const variants = await db.query<{ id: string }>(
        `select id from public.variants
         where destination_url in ('https://example.com/v1','https://example.com/v2')
         order by destination_url`,
      );
      const [va, vb] = variants.rows.map((row) => row.id);
      await db.query(
        `insert into public.chatbot_nodes (id, owner_id, variant_id, prompt)
         values ('cccccccc-0000-0000-0000-000000000001', $1, $2, '親')`,
        [USER_A, va],
      );
      const code = await sqlstateOf(db, () =>
        db.query(
          `insert into public.chatbot_nodes (owner_id, variant_id, parent_node_id, prompt)
           values ($1, $2, 'cccccccc-0000-0000-0000-000000000001', '別シナリオの子')`,
          [USER_A, vb],
        ),
      );
      expect(code).toBe("23503");
    });

    it("✅ 同じバリアントのノードは親にできる", async () => {
      const variants = await db.query<{ id: string }>(
        `select id from public.variants where destination_url = 'https://example.com/v1'`,
      );
      const code = await sqlstateOf(db, () =>
        db.query(
          `insert into public.chatbot_nodes (owner_id, variant_id, parent_node_id, prompt)
           values ($1, $2, 'cccccccc-0000-0000-0000-000000000001', '同じシナリオの子')`,
          [USER_A, variants.rows[0].id],
        ),
      );
      expect(code).toBe("");
    });
  });

  /*
    ────────────────────────────────────────────────────────────────────
    6. 関門そのものが空回りしていないか(**壊して赤くなることを見る**)
    ────────────────────────────────────────────────────────────────────
    🔴 「関門が在る」と「関門が守っている」の距離は、**壊してみるまで分からない**。
    ⚠ ここは実際に権限を緩めてから関門を呼び、**元へ戻す**。
  */
  describe("関門(adpop_assert_privilege_rules)の実力", () => {
    async function assertGuardRejects(brokenSql: string, restoreSql: string, hint: string): Promise<void> {
      await db.exec(brokenSql);
      const code = await sqlstateOf(db, () => db.query(`select public.adpop_assert_privilege_rules()`));
      await db.exec(restoreSql);
      // raise exception の既定は P0001
      expect(code, hint).toBe("P0001");
      // 戻したら通ること(戻し漏れをここで見つける)
      await db.query(`select public.adpop_assert_privilege_rules()`);
    }

    it("表の権限を anon へ1つ配ると落ちる", async () => {
      await assertGuardRejects(
        `grant select on public.sites to anon;`,
        `revoke all on public.sites from anon;`,
        "anon に select を配っても関門が通った",
      );
    });

    it("🔴 列単位で配っても落ちる(has_table_privilege だけでは見えない)", async () => {
      await assertGuardRejects(
        `grant select (site_key) on public.sites to anon;`,
        `revoke all on public.sites from anon;`,
        "列単位の grant を関門が見落とした",
      );
    });

    it("既定privilege を戻すと落ちる(これから作られる表が配られる)", async () => {
      await assertGuardRejects(
        `alter default privileges in schema public grant select on tables to anon;`,
        `alter default privileges in schema public revoke all on tables from anon;`,
        "既定privilege の緩みを関門が見落とした",
      );
    });

    it("RLS を無効にすると落ちる", async () => {
      await assertGuardRejects(
        `alter table public.events disable row level security;`,
        `alter table public.events enable row level security;`,
        "RLS を切っても関門が通った",
      );
    });

    it("allow-list に無い関数を anon へ開けると落ちる", async () => {
      await assertGuardRejects(
        `grant usage on schema public to anon;
         grant execute on function public.adpop_is_https_url(text) to anon;`,
        `revoke all on function public.adpop_is_https_url(text) from anon;
         revoke usage on schema public from anon;`,
        "anon に関数を開けても関門が通った",
      );
    });

    it("authenticated に TRUNCATE を配ると落ちる(RLS はここに掛からない)", async () => {
      await assertGuardRejects(
        `grant truncate on public.sites to authenticated;`,
        `revoke truncate on public.sites from authenticated;`,
        "TRUNCATE を配っても関門が通った",
      );
    });

    it("🔴 allow-list に無い関数を authenticated へ配ると落ちる(Codex 1巡目 High)", async () => {
      /*
        🔴 **これが元の穴**: 関門(c)が anon / service_role / PUBLIC しか見ていなかったので、
          `security definer` の関数を1本足して authenticated に配れば、
          **RLS を1枚も通らない書き込み口**が誰にも気づかれずに作れた。
      */
      await assertGuardRejects(
        `create function public.zz_secdef_backdoor() returns int
           language sql security definer set search_path = '' as 'select 1';
         grant execute on function public.zz_secdef_backdoor() to authenticated;`,
        `drop function public.zz_secdef_backdoor();`,
        "authenticated に配った secdef 関数を関門が見落とした",
      );
    });

    it("🔴 security definer なのに search_path が固定されていないと落ちる", async () => {
      await assertGuardRejects(
        `create function public.zz_secdef_no_path() returns int
           language sql security definer as 'select 1';`,
        `drop function public.zz_secdef_no_path();`,
        "search_path を固定していない secdef 関数を関門が見落とした",
      );
    });

    it("✅ いま在る secdef 関数は search_path が固定されている(締めすぎていない)", async () => {
      const r = await db.query<{ fn: string; config: string[] | null }>(
        `select p.oid::regprocedure::text as fn, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef order by 1`,
      );
      // 現状 secdef はトリガの1本だけ。増えたらここが気づく。
      expect(r.rows.map((row) => row.fn)).toEqual(["adpop_seed_popup_triggers()"]);
      for (const row of r.rows) {
        expect(row.config?.some((c) => c.startsWith("search_path=")), row.fn).toBe(true);
      }
    });

    it("🔴 allow-list に実在しない署名を書くと落ちる(黙って空にならない)", async () => {
      await assertGuardRejects(
        `create or replace function public.adpop_authenticated_callable_functions()
           returns text[] language sql immutable as
           $body$ select array['public.adpop_is_https_url(text)', 'public.typo_does_not_exist(text)']::text[] $body$;`,
        `create or replace function public.adpop_authenticated_callable_functions()
           returns text[] language sql immutable as
           $body$ select array['public.adpop_is_https_url(text)','public.adpop_is_origin(text)','public.adpop_is_origin_list(text[])']::text[] $body$;`,
        "allow-list の誤記を関門が見落とした",
      );
    });

    it("anon から呼べる関数が0本なのに USAGE だけ開けると落ちる", async () => {
      await assertGuardRejects(
        `grant usage on schema public to anon;`,
        `revoke usage on schema public from anon;`,
        "使い道の無い USAGE を関門が見落とした",
      );
    });
  });
});

/*
  ══════════════════════════════════════════════════════════════════════════
  7. すべてのマイグレーションが末尾で関門を呼ぶ
  ══════════════════════════════════════════════════════════════════════════
  🔴 **1度しか流れないマイグレーションを、次のマイグレーションが検算する形**にしている。
    呼び忘れると、その回の変更だけが測られないまま通る。
*/
describe("0001 の再実行", () => {
  /*
    🔴 0001 は「途中で止まった人が流し直せる」ことを条件にしている。**その主張を実際に撃つ。**
    ⚠ 主張の範囲は 0001 だけ。**0002 は再実行できない**(`create type` が落ちる)ことも、
      同じ場所で固定しておく —— 書いていないと、次に読む人が両方できると思う。
  */
  it("0001 をもう一度流しても通り、0002 が配った権限が剥がれない", async () => {
    const db = await createMigratedDb(START_ACLS[0]);
    try {
      const first = await db.query<{ granted: boolean }>(
        `select has_table_privilege('authenticated', 'public.sites', 'INSERT') as granted`,
      );
      expect(first.rows[0].granted).toBe(true);

      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILES[0]), "utf8"));

      const after = await db.query<{ granted: boolean }>(
        `select has_table_privilege('authenticated', 'public.sites', 'INSERT') as granted`,
      );
      expect(after.rows[0].granted, "0001 を流し直したら 0002 の grant が消えた").toBe(true);
      // 関門も通る
      await db.query(`select public.adpop_assert_privilege_rules()`);
    } finally {
      await db.close();
    }
  });

  it("⚠ 0002 は再実行できない(できるつもりで書かないための固定)", async () => {
    const db = await createMigratedDb(START_ACLS[0]);
    try {
      const code = await sqlstateOf(db, () =>
        db.exec(readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILES[1]), "utf8")),
      );
      // 42710 = duplicate_object(型が既に在る)
      expect(code).toBe("42710");
    } finally {
      await db.close();
    }
  });
});

describe("マイグレーションの作法", () => {
  it("すべてのマイグレーションが末尾で関門を呼んでいる", () => {
    expect(migrationsMissingGuard(MIGRATIONS_DIR)).toEqual([]);
  });

  it("関門の呼び出し文の形が固定されている", () => {
    expect(GUARD_CALL).toBe("select public.adpop_assert_privilege_rules();");
  });

  it("マイグレーションが1本以上ある(空のディレクトリで緑にならない)", () => {
    expect(MIGRATION_FILES.length).toBeGreaterThan(0);
  });

  it("業務テーブルの一覧が、実物の PostgREST を叩く検査と一致している", () => {
    /*
      ⚠ 表の一覧が2か所に在る(ここと `scripts/postgrest-expectations.mjs`)。
        **写しなので、機械で突き合わせる** —— 表を1つ足して片方だけ直したら、ここが落ちる。
      🔴 型のために `as const` の配列をこちら側に置いている(import すると `string[]` になり、
        `GRANTED_DML` の網羅が型で効かなくなる)。**その代わりに照合を1本置く**、という判断。
    */
    expect([...TABLES]).toEqual(POSTGREST_TABLES);
  });
});
