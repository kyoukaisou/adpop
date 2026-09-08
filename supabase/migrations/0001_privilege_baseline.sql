-- ADPOP 0001: 権限の土台を「配らない」に倒し、それを毎回検算する関門を置く。
--
-- 🔴 **なぜ最初のマイグレーションがこれなのか**
--   Supabase は **既定privilege(default privileges)で、あとから作られる表・連番・関数に
--   `anon` / `authenticated` / `service_role` の権限を自動で配る**。
--   マイグレーションに `grant` を1文字も書いていなくても、**新しい表は最初から触れる状態で生まれる**。
--   [[NKARTE]] は 0001 でこれを踏み、0021 まで気づかなかった(= 20本ぶんの表が余分な権限を持っていた)。
--   → **表を1つも作る前に、既定privilege を止める。**
--
-- 🔴 **並びの規則(2026-09-07 / [[SaaS開発ナレッジ]] の型)**: 締める側を先に、開ける側を後に。
--   文ごとにコミットされる環境では、このファイルは**どの文の直後でも止まりうる**。
--   ここで「開ける」のは `grant usage on schema public to authenticated` の1文だけで、
--   **スキーマの USAGE 単体では1つの表にも触れない**(オブジェクトの権限は0本のまま)。
--   → **どの文の直後で止まっても、触れる範囲は広がらない。** 表と grant(開ける側)は 0002 に置く。
--
-- 🔴 **再実行できること**: 途中で止まった人が最初にやるのは「同じファイルを流し直す」。
--   `create or replace` と `revoke`(冪等)だけで書く。

-- ══════════════════════════════════════════════════════════════════════
-- ① 既定privilege を止める(これから作られるものに、何も配らない)
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠ **「多い分を引く」ではなく「全部配らない」に倒す。**
--   開始ACLは環境で違う(素の supabase/postgres イメージと supabase CLI のローカルスタックで
--   実測値が違うことが [[NKARTE]] で分かっている)。差を引く書き方は、**どちらの環境から流したかで
--   終点が変わる**。配らないに倒せば、どちらから流しても終点が同じになる。
-- 🔴 代償: **表を足して grant を書き忘れると、その表は管理画面から見えない。**
--   ⚠ 逆(黙って全公開)より安全だが、黙って壊れることに変わりはない。
--   → 0002 以降は表を足したら必ず grant を書く。書き忘れは「画面に出ない」で気づく。
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role, public;
alter default privileges in schema public revoke all on functions from anon, authenticated, service_role, public;

-- 🔴🔴 **`in schema public` を付けた revoke だけでは足りない(2026-09-08 実測)**
--   PostgreSQL の組み込みの既定「**関数の EXECUTE を PUBLIC に配る**」は
--   **グローバル側の既定ACL**に在り、**スキーマ限定の revoke はそこから1ミリも引けない**
--   (スキーマ限定とグローバルは**マージ**され、スキーマ限定の revoke は
--    スキーマ限定の grant からしか引けない)。
--   実測: `postgres:17-alpine` と PGlite の両方で、
--     `alter default privileges in schema public revoke all on functions from public;`
--     → `pg_default_acl` は0行のまま・新しい関数は PUBLIC が実行できる
--     `alter default privileges revoke all on functions from public;`(スキーマ指定なし)
--     → `{postgres=X/postgres}` が記録され、新しい関数は PUBLIC から実行できない
--   ⚠ **カタログが空なのは「配っていない」ではなく「組み込みの既定のまま」**。
--     だから (f) は**実際に1つ作って測る**。
--
-- ⚠ **グローバル側は「postgres が作るオブジェクト」全部に効く**(スキーマを問わない)。
--   このリポジトリのマイグレーションは postgres が流し、public にしか作らないので影響は同じ。
--   ⚠ 将来 `create extension` を migration で行うと、その関数群も PUBLIC から実行できなくなる。
--     そのときは (f-3) が**適用時に落ちて人に判断させる**(黙って壊れない)。
alter default privileges revoke all on tables from anon, authenticated, service_role, public;
alter default privileges revoke all on sequences from anon, authenticated, service_role, public;
alter default privileges revoke all on functions from anon, authenticated, service_role, public;
-- ⚠ **型(types)の既定privilege は触らない。** 型の USAGE は「その型を使って表や関数を作れる」権限で、
--   **誰かの行を読む経路ではない**。逆に剥がすと、列挙型を持つ列を authenticated が扱う経路
--   (キャスト・関数引数)が壊れうる。**塞ぐ理由が無いものを塞がない**(壊れ方だけが増える)。

-- ② いま public スキーマに在るものからも剥がす(プラットフォーム側が置いたものがありうる)
--   🔴 **ここに `authenticated` を入れない理由**: このファイルは**再実行できる**ことを条件にしている。
--     入れてしまうと、0002 より後にこのファイルを流し直した人が
--     **0002 が配った権限を全部剥がしてしまう**(= 管理画面が黙って空になる)。
--     authenticated に余分な権限が付いていないことは、下の関門(b)が毎回測る。
revoke all on all tables in schema public from anon, service_role, public;
revoke all on all sequences in schema public from anon, service_role, public;
revoke all on all functions in schema public from anon, service_role, public;

-- ③ スキーマそのものの権限
--   🔴 **`from public` を落とさないと `from anon` は効かない。** schema public の USAGE は
--     既定で **PUBLIC 疑似ロール**に付いているので、anon から revoke しても
--     `has_schema_privilege('anon','public','USAGE')` は真のまま(継承する)。
--     → **PUBLIC ごと落として、要るロールに明示で配り直す。**
--   ⚠ `usage` を持っていても、オブジェクトの権限が無ければ何も触れない。
--     それでも anon から落としておく = **配信用の関数を PR2 で1本開けるまで、anon の入口は無い**。
--   ⚠ `create` は誰にも配らない(利用者のセッションから表を作れる状態を残さない)。
revoke all on schema public from public, anon, authenticated, service_role;
grant usage on schema public to authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- ④ anon から呼べる関数の allow-list(**裏返し**)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **「危ないものを数え上げる」ではなく「通してよいものを1つ指す」形にする**
--   ([[SaaS開発ナレッジ]] 2026-09-08: 除外の一覧は必ず数え落とすが、
--    allow-list は数え落としが原理的に無い)。
--
-- PR1 では **空**。配信エンドポイント(サイトキー → 設定 JSON)が入る PR2 で、
-- **この関数を `create or replace` して署名を1本だけ足す**。
-- ⚠ 足したら、その関数が fail-closed(未登録の Origin には返さない)であることを別に検査する。
create or replace function public.adpop_anon_callable_functions()
returns text[]
language sql
immutable
as $$
  -- 例(PR2): array['public.adpop_site_config(text, text)']
  select '{}'::text[];
$$;

comment on function public.adpop_anon_callable_functions() is
  'anon が EXECUTE を持ってよい public スキーマの関数(regprocedure の文字列)。ここに無い関数を anon が呼べたら 0001 の関門が落ちる。';

-- ══════════════════════════════════════════════════════════════════════
-- ⑤ 関門: 権限の実効値を毎回測る
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **測るのは「書いた SQL」ではなく「いまそうなっている状態」。**
--   マイグレーションは1度しか流れないので、**書いた時点で正しかったこと**は
--   **いまも正しいこと**を1ミリも言わない。だから毎回のマイグレーションの末尾で呼ぶ。
-- 🔴 **カタログ(pg_default_acl)を読まない。** スキーマ限定の既定ACLとグローバルの既定ACLは
--   マージされるので、**カタログの見た目と、実際に作られる表のACLは一致しない**([[NKARTE]] 0021)。
--   → **実際に1つ作って測り、すぐ消す**(検算する場所と実効する場所をずらさない)。
create or replace function public.adpop_assert_privilege_rules()
returns void
language plpgsql
as $$
declare
  -- MAINTAIN は PostgreSQL 17 で追加された。16 以下に渡すと引数エラーになるので版で切り替える。
  is_pg17    constant boolean := current_setting('server_version_num')::int >= 170000;
  table_privs text[] := case when is_pg17
                          then array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
                          else array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] end;
  -- 列単位の grant が在りうる権限。
  -- ⚠ `has_table_privilege` は**列単位の grant を映さない**([[SaaS開発ナレッジ]] 2026-09-08-07)。
  --   `grant select (site_key) on sites to anon` は表単位では偽になるので、両方で測る。
  column_privs constant text[] := array['SELECT','INSERT','UPDATE','REFERENCES'];
  extra_privs  text[] := case when is_pg17
                          then array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
                          else array['TRUNCATE','REFERENCES','TRIGGER'] end;
  allowed     constant text[] := public.adpop_anon_callable_functions();
  offenders   text[];
  probe_tbl   constant text := 'zz_adpop_privilege_probe_tbl';
  probe_seq   constant text := 'zz_adpop_privilege_probe_seq';
  probe_fn    constant text := 'zz_adpop_privilege_probe_fn';
begin
  -- (a) public の表・ビューに、anon / service_role / PUBLIC は権限を1つも持たない
  --     ⚠ 表単位と列単位の両方で測る。
  select coalesce(array_agg(format('%s|%s|%s', rel, grantee, priv) order by 1), '{}')
    into offenders
  from (
    select c.oid::regclass::text as rel, ro.g as grantee, p as priv
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('service_role'), ('public')) ro(g)
    cross join unnest(table_privs) as p
    where n.nspname = 'public'
      and case when c.relkind in ('r','v','m','p','f')
               then has_table_privilege(ro.g, c.oid, p)
                 or (p = any (column_privs) and has_any_column_privilege(ro.g, c.oid, p))
               else false end
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(a): anon / service_role / PUBLIC が public の表に権限を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  -- (a2) 連番も同じ。⚠ identity 列は裏に連番を作る(`events_id_seq`)。
  --      表の権限だけ見ていると、**連番だけが配られている状態**を見落とす。
  select coalesce(array_agg(format('%s|%s|%s', rel, grantee, priv) order by 1), '{}')
    into offenders
  from (
    select c.oid::regclass::text as rel, ro.g as grantee, p as priv
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('service_role'), ('public')) ro(g)
    cross join unnest(array['USAGE','SELECT','UPDATE']) as p
    where n.nspname = 'public' and c.relkind = 'S'
      and has_sequence_privilege(ro.g, c.oid, p)
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(a2): anon / service_role / PUBLIC が public の連番に権限を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  -- (b) authenticated は SELECT/INSERT/UPDATE/DELETE の外側を持たない
  --     ⚠ 🔴 **RLS は TRUNCATE に適用されない**(ポリシーが1枚も掛からない)。
  --       TRUNCATE / TRIGGER / REFERENCES / MAINTAIN が付いていたら、行の分離は無いのと同じ。
  select coalesce(array_agg(format('%s|%s', rel, priv) order by 1), '{}')
    into offenders
  from (
    select c.oid::regclass::text as rel, p as priv
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join unnest(extra_privs) as p
    where n.nspname = 'public'
      and case when c.relkind in ('r','v','m','p','f')
               then has_table_privilege('authenticated', c.oid, p) else false end
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(b): authenticated が DML の外側の権限を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  -- (c) public の関数の EXECUTE。anon は allow-list の分だけ、service_role / PUBLIC は0本。
  select coalesce(array_agg(format('%s|%s', fn, grantee) order by 1), '{}')
    into offenders
  from (
    select p.oid::regprocedure::text as fn, ro.g as grantee
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('service_role'), ('public')) ro(g)
    where n.nspname = 'public'
      and has_function_privilege(ro.g, p.oid, 'EXECUTE')
      and not (ro.g = 'anon' and p.oid::regprocedure::text = any (allowed))
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(c): allow-list に無い関数を anon / service_role / PUBLIC が実行できます: %',
      array_to_string(offenders, ', ');
  end if;

  -- (d) public の表はすべて RLS が有効
  --     ⚠ 権限を配っていなくても有効にする。**grant が1文入った日に、行の分離が既に在る**ため
  --       (grant だけでは通らない = 迂回には「権限」と「ポリシー」の2つが要る)。
  select coalesce(array_agg(c.oid::regclass::text order by 1), '{}')
    into offenders
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(d): RLS が有効でない表があります: %', array_to_string(offenders, ', ');
  end if;

  -- (e) スキーマの権限。anon の USAGE は「allow-list が空でないとき」だけ許す。
  --     ⚠ USAGE 単体では何も触れないが、**入口を開ける理由が無いのに開いている状態**を残さない。
  if has_schema_privilege('anon', 'public', 'USAGE') and array_length(allowed, 1) is null then
    raise exception 'ADPOP 権限の関門(e): anon から呼べる関数が0本なのに、anon が public スキーマの USAGE を持っています';
  end if;
  if has_schema_privilege('public', 'public', 'CREATE')
     or has_schema_privilege('anon', 'public', 'CREATE')
     or has_schema_privilege('authenticated', 'public', 'CREATE')
     or has_schema_privilege('service_role', 'public', 'CREATE') then
    raise exception 'ADPOP 権限の関門(e2): public スキーマの CREATE が業務ロールに配られています';
  end if;

  -- (f) **これから作られるもの**に権限が配られない(実際に作って測り、消す)
  --     ⚠ **(d) より後に置く。** ここで作る検査用の表は RLS を有効にしないので、
  --       (d) の前に作ると「RLS が無効な表が在る」で自分自身に落とされる。
  --       ⚠ 並べ替えるときはここを読むこと(順序が意味を持っている)。
  execute format('create table public.%I (id integer)', probe_tbl);
  execute format('create sequence public.%I', probe_seq);
  execute format('create function public.%I() returns integer language sql as $q$select 1$q$', probe_fn);

  select coalesce(array_agg(format('table|%s|%s', grantee, priv) order by 1), '{}')
    into offenders
  from (
    select ro.g as grantee, p as priv
    from (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
    cross join unnest(table_privs) as p
    where has_table_privilege(ro.g, format('public.%I', probe_tbl)::regclass, p)
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(f-1): 新しく作られる表に権限が配られます: %', array_to_string(offenders, ', ');
  end if;

  select coalesce(array_agg(format('sequence|%s|%s', grantee, priv) order by 1), '{}')
    into offenders
  from (
    select ro.g as grantee, p as priv
    from (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
    cross join unnest(array['USAGE','SELECT','UPDATE']) as p
    where has_sequence_privilege(ro.g, format('public.%I', probe_seq)::regclass, p)
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(f-2): 新しく作られる連番に権限が配られます: %', array_to_string(offenders, ', ');
  end if;

  select coalesce(array_agg(format('function|%s', grantee) order by 1), '{}')
    into offenders
  from (
    select ro.g as grantee
    from (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
    where has_function_privilege(ro.g, format('public.%I()', probe_fn)::regprocedure, 'EXECUTE')
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(f-3): 新しく作られる関数を業務ロールが実行できます: %', array_to_string(offenders, ', ');
  end if;

  execute format('drop function public.%I()', probe_fn);
  execute format('drop sequence public.%I', probe_seq);
  execute format('drop table public.%I', probe_tbl);
end;
$$;

comment on function public.adpop_assert_privilege_rules() is
  'すべてのマイグレーションの末尾で呼ぶ関門。書いた SQL ではなく、実効の権限を測る。';

-- 関門そのものを業務ロールから呼べないようにする(結果を見せる意味も無い)
revoke all on function public.adpop_assert_privilege_rules() from public, anon, authenticated, service_role;
revoke all on function public.adpop_anon_callable_functions() from public, anon, authenticated, service_role;

select public.adpop_assert_privilege_rules();
