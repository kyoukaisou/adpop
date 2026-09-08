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
--   ここで「開ける」のは2つだけ:
--     ① `grant usage on schema public to authenticated`(③)
--     ② **末尾の ⑥ が、allow-list に載っている関数の EXECUTE と、そのスキーマの USAGE を anon へ配り直す**
--   **どちらも「宣言してある分」だけ**で、**スキーマの USAGE 単体では1つの表にも触れない**
--   (オブジェクトの権限は、0002 が明示的に配るまで0本のまま)。
--   → **どの文の直後で止まっても、宣言より広く開くことはない。** 表と grant(開ける側の本体)は 0002 に置く。
--   ⚠ PR1 では allow-list が空なので ② は1文も実行しない。効き始めるのは PR2 から。
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
--
-- 🔴 **将来 `create extension` を migration で行ったときに何が起きるか(正確に)**
--   (Codex 1巡目 Medium。⚠ ここには当初「そのときは (f-3) が適用時に落ちて人に判断させる」と
--    書いていたが、**実装はそうなっていなかった** = 説明が実装より広い約束をしていた):
--   ・**起きること**: その extension の関数は **PUBLIC から実行できない状態で作られる**
--     (グローバルの既定privilege は全スキーマに効くため)。
--   ・**関門は検知しない**: (c)(c2) が見るのは **`adpop_exposed_schemas()` に載っているスキーマだけ**
--     (いまは `public` の1つ)で、extension は普通 `extensions` スキーマに入る。(f-3) が測るのは
--     **「新しい関数が実行できないこと」= 合格側**なので、こちらも鳴らない。
--   ・**したがって**: extension を足すマイグレーションでは、**必要な EXECUTE を明示的に配ること**。
--     配り忘れは「その機能が動かない」で気づく(黙って全公開になる向きではない)。
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
/*
  ══════════════════════════════════════════════════════════════════════
  ④-0 **関門が見るスキーマの集合**(Codex 2巡目 High)
  ══════════════════════════════════════════════════════════════════════
  🔴 **何が起きていたか**: `supabase/config.toml` の `[api] schemas` は既定で
    `["public", "graphql_public"]` で、**両方が Data API に出ている**。
    ところが関門は `nspname = 'public'` を直に書いていたので、
    **`graphql_public` に authenticated 向けの secdef 関数を1本作れば、
    allow-list も search_path の関門も丸ごと迂回できた。**
  📌 型: **検査対象の集合が、設定とは別の場所で別々に育つ。**
    「public だけを見る」は**そのとき正しかった**だけで、**設定が変わった日に黙って穴になる**。
  ✅ **集合を SQL 側の1か所に置き**、関門(a)(a2)(b)(c)(c2)(d)を**全部この集合で走らせる**。
  ✅ **`config.toml` の `schemas` がこの集合の部分集合であること**を、テストで機械的に突き合わせる
    (`supabase/tests/schema.test.ts`)。**設定を広げたら、関門も広げないと落ちる。**
  ⚠ ここも「無ければ作る」(下の allow-list と同じ理由)。
    `create or replace` にすると、**後で広げた集合を、0001 の流し直しが元に戻す** =
    **検査対象が黙って狭まる**(= 緩む向き)。
*/
do $$
begin
  if to_regprocedure('public.adpop_exposed_schemas()') is null then
    execute $q$
      create function public.adpop_exposed_schemas()
      returns text[] language sql immutable as $body$ select array['public']::text[] $body$;
    $q$;
  end if;
end $$;

comment on function public.adpop_exposed_schemas() is
  'Data API に出ているスキーマ。関門はこの集合の中だけを見る。supabase/config.toml の [api] schemas と機械で突き合わせる。';

/*
  🔴🔴 **`create or replace` では書かない。「無ければ作る」にする**(2026-09-08。自分の再実行テストが捕まえた)。
    0001 は**流し直せる**ことを条件にしているが、`create or replace` で空に戻すと、
    **後のマイグレーションが宣言した allow-list を、流し直した瞬間に全部消す**。
    そのあと関門(c)が「配ってあるのに宣言に無い」で落ちる = **流し直した人が理由の分からない赤を見る。**
  ⚠ したがって **allow-list の初期値を作るのはこの1回だけ**で、
    更新は**配る側のマイグレーションが `create or replace` で行う**(0002 がそうしている)。

  🔴 **「宣言が残る」だけでは足りない**(Codex 2巡目 Medium)。
    ② と ③ は流し直すたびに **anon から権限とスキーマの USAGE を剥がす**ので、
    宣言が残っていても**配信口は止まる**。
    → **⑥(このファイルの末尾)が、宣言してある分を配り直す。**
    → **関門(e3)(e4)が「いま実際に配られている」ことを状態として測る。**
    ⚠ 3つ揃って初めて「流し直しても壊れない」と言える。**宣言・配り直し・状態の検査**。
*/
do $$
begin
  if to_regprocedure('public.adpop_anon_callable_functions()') is null then
    execute $q$
      create function public.adpop_anon_callable_functions()
      returns text[] language sql immutable as
      -- 例(PR2): array['public.adpop_site_config(text, text)']
      $body$ select '{}'::text[] $body$;
    $q$;
  end if;
end $$;

comment on function public.adpop_anon_callable_functions() is
  'anon が EXECUTE を持ってよい public スキーマの関数(regprocedure の文字列)。ここに無い関数を anon が呼べたら 0001 の関門が落ちる。';

/*
  🔴🔴 **authenticated 側にも同じ allow-list を置く**(Codex 1巡目 High)。
    最初は関門(c)の対象を anon / service_role / PUBLIC の3つにしていた。
    それだと **`security definer` の関数を1本足して authenticated に EXECUTE を配るだけで、
    RLS も課金の関門も通らない書き込み口を作れる**(その関数は表の所有者の権限で走る)。
    ⚠ **anon より authenticated のほうが危ない** —— 誰でも無料で登録できるようにすれば、
      その口は事実上だれでも叩ける。
  → **authenticated が EXECUTE を持ってよい関数も、ここに宣言した分だけ**にする。
  ⚠ **PR1 の時点で空ではない。** 0002 が CHECK 制約から呼ぶ述語3本を
    `create or replace` でここへ足す(**配る側と宣言する側を同じマイグレーションに置く**)。
*/
-- ⚠ 上と同じ理由で「無ければ作る」(流し直しで 0002 の宣言を消さない)
do $$
begin
  if to_regprocedure('public.adpop_authenticated_callable_functions()') is null then
    execute $q$
      create function public.adpop_authenticated_callable_functions()
      returns text[] language sql immutable as $body$ select '{}'::text[] $body$;
    $q$;
  end if;
end $$;

comment on function public.adpop_authenticated_callable_functions() is
  'authenticated が EXECUTE を持ってよい public スキーマの関数(regprocedure の文字列)。配るマイグレーションが同時にここへ足す。';

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
  -- 🔴 関門が見るスキーマ。**ここだけが集合を持つ**(catalog を引く検査は全部これを使う)。
  exposed      constant text[] := public.adpop_exposed_schemas();
  allowed      constant text[] := public.adpop_anon_callable_functions();
  allowed_auth constant text[] := public.adpop_authenticated_callable_functions();
  /*
    🔴 **allow-list は文字列ではなく OID で突き合わせる**(2026-09-08 実測)。
      `oid::regprocedure::text` は **search_path 依存**で、public が search_path に在ると
      `public.` が落ちて `adpop_is_https_url(text)` になる。
      文字列で比べると、**流す環境の search_path で allow-list が黙って効かなくなる。**
    ⚠ 解決できない署名(誤記・消した関数)は**その場で落とす**。
      放っておくと「allow-list が空になった」= 一見 fail-closed だが、
      **なぜ落ちたのかが誰にも分からない**形で関門が鳴る。
  */
  allowed_oids      oid[];
  allowed_auth_oids oid[];
  unresolved        text[];
  offenders   text[];
  probe_tbl   constant text := 'zz_adpop_privilege_probe_tbl';
  probe_seq   constant text := 'zz_adpop_privilege_probe_seq';
  probe_fn    constant text := 'zz_adpop_privilege_probe_fn';
begin
  -- (0) allow-list の署名を OID に解決する。解決できないものが1つでもあれば落とす。
  select coalesce(array_agg(sig order by sig), '{}') into unresolved
  from unnest(allowed || allowed_auth) as sig
  where to_regprocedure(sig) is null;
  if array_length(unresolved, 1) is not null then
    raise exception 'ADPOP 権限の関門(0): allow-list に、実在しない関数の署名があります: %',
      array_to_string(unresolved, ', ');
  end if;
  select coalesce(array_agg(to_regprocedure(sig)::oid), '{}') into allowed_oids
  from unnest(allowed) as sig;
  select coalesce(array_agg(to_regprocedure(sig)::oid), '{}') into allowed_auth_oids
  from unnest(allowed_auth) as sig;

  /*
    (0b) 🔴 **allow-list に載せてよいのは、関門が見ているスキーマの関数だけ**(Codex 3巡目 Medium)。
      ⑥ は allow-list の関数の**在るスキーマに anon の USAGE を配る**。
      そこが `adpop_exposed_schemas()` の外だと:
        ・**そのスキーマの他の関数**(PUBLIC が実行できるもの)が (c) の対象外のまま anon から届く
        ・**そのスキーマの表**も (a)(d) の対象外
      = **allow-list に1行足すだけで、関門の届かない入口を開ける**ことになる。
    ⚠ これは §2026-09-08-51 と同じ型(集合が別の場所で育つ)の3例目。
  */
  select coalesce(array_agg(format('%s(%s)', sig, n.nspname) order by sig), '{}') into offenders
  from unnest(allowed || allowed_auth) as sig
  join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where not (n.nspname = any (exposed));
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(0b): 関門が見ていないスキーマの関数が allow-list に載っています: %',
      array_to_string(offenders, ', ');
  end if;

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
    where n.nspname = any (exposed)
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
    where n.nspname = any (exposed) and c.relkind = 'S'
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
    where n.nspname = any (exposed)
      and case when c.relkind in ('r','v','m','p','f')
               then has_table_privilege('authenticated', c.oid, p) else false end
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(b): authenticated が DML の外側の権限を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  -- (c) public の関数の EXECUTE。**4ロールとも allow-list の分だけ**(service_role / PUBLIC は空のまま)。
  --     🔴 **authenticated を外していたのが穴だった**(Codex 1巡目 High)。
  --       `security definer` の関数を1本足して authenticated に配れば、
  --       RLS を通らない書き込み口ができる。**anon より広く使われる口なので、こちらのほうが危ない。**
  select coalesce(array_agg(format('%s|%s', fn, grantee) order by 1), '{}')
    into offenders
  from (
    select p.oid::regprocedure::text as fn, ro.g as grantee
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
    where n.nspname = any (exposed)
      and has_function_privilege(ro.g, p.oid, 'EXECUTE')
      and not (ro.g = 'anon' and p.oid = any (allowed_oids))
      and not (ro.g = 'authenticated' and p.oid = any (allowed_auth_oids))
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(c): allow-list に無い関数を実行できるロールがあります: %',
      array_to_string(offenders, ', ');
  end if;

  /*
    (c2) 🔴 **`security definer` の関数は、`search_path` が固定されていなければ通さない。**
      定義者の権限で走る関数の `search_path` が呼び出し側任せだと、
      **呼ぶ側が自分のスキーマに同名の表や関数を置いて、中身をすり替えられる**。
    ⚠ **所有者を問わない**(誰が作ったかではなく、`prosecdef` が真かどうかで見る)。
    ⚠ 見ているのは「**固定されているか**」だけで、**中身が安全かは1つも見ていない**。
      安全側の値(`''` か `pg_catalog` で始まる形)にするのは書く人の責任。
  */
  select coalesce(array_agg(p.oid::regprocedure::text order by 1), '{}')
    into offenders
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = any (exposed)
    and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
      where cfg like 'search_path=%'
    );
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(c2): security definer の関数に search_path の固定がありません: %',
      array_to_string(offenders, ', ');
  end if;

  -- (d) public の表はすべて RLS が有効
  --     ⚠ 権限を配っていなくても有効にする。**grant が1文入った日に、行の分離が既に在る**ため
  --       (grant だけでは通らない = 迂回には「権限」と「ポリシー」の2つが要る)。
  select coalesce(array_agg(c.oid::regclass::text order by 1), '{}')
    into offenders
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = any (exposed) and c.relkind in ('r','p') and not c.relrowsecurity;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(d): RLS が有効でない表があります: %', array_to_string(offenders, ', ');
  end if;

  /*
    (e) スキーマの権限。anon の USAGE は「allow-list が空でないとき」だけ許す。
    ⚠ USAGE 単体では何も触れないが、**入口を開ける理由が無いのに開いている状態**を残さない。
    🔴 **`public` 固定をやめて集合で回す**(Codex 3巡目 Medium)。
      `adpop_exposed_schemas()` を増やしても、増やしたスキーマの anon USAGE と CREATE を
      1つも見ていなかった = **2巡目に直した型(集合が別の場所で育つ)の、直し残し**。
  */
  select coalesce(array_agg(ns order by ns), '{}') into offenders
  from unnest(exposed) as ns
  where has_schema_privilege('anon', ns, 'USAGE') and array_length(allowed, 1) is null;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e): anon から呼べる関数が0本なのに、anon が USAGE を持つスキーマがあります: %',
      array_to_string(offenders, ', ');
  end if;

  select coalesce(array_agg(format('%s|%s', ns, ro.g) order by 1), '{}') into offenders
  from unnest(exposed) as ns
  cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
  where has_schema_privilege(ro.g, ns, 'CREATE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e2): スキーマの CREATE が業務ロールに配られています: %',
      array_to_string(offenders, ', ');
  end if;

  /*
    (e3) 🔴🔴 **allow-list に載っている関数を、anon が「いま実際に」実行できること**
      (Codex 2巡目 Medium)。
      ここまでの検査は全部「**配りすぎていないか**」の向きだった。逆向き ——
      **配るべきものが配られていない** —— を1つも見ていなかった。
      🔴 実害: PR2 で配信の関数を開けた後に **0001 を流し直す**と、
        ② の `revoke all on all functions … from anon` と ③ の schema USAGE の revoke が走り、
        **配信エンドポイントが黙って 42501 を返すようになる**(LP 側は fail-closed で何も出なくなる)。
        マイグレーションは緑、テストも緑、**気づくのは訪問者が減ってから**。
      ✅ 下の ⑥ が**流し直しのたびに配り直す**。ここはその結果を**状態として**測る
        (「配り直す文を書いた」ではなく「いま配られている」を見る)。
  */
  select coalesce(array_agg(sig order by sig), '{}') into offenders
  from unnest(allowed) as sig
  where not has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e3): allow-list に載っているのに anon が実行できない関数があります: %',
      array_to_string(offenders, ', ');
  end if;

  select coalesce(array_agg(distinct ns order by ns), '{}') into offenders
  from (
    select n.nspname as ns
    from unnest(allowed) as sig
    join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  ) s
  where not has_schema_privilege('anon', ns, 'USAGE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e4): allow-list の関数が在るスキーマの USAGE を anon が持っていません: %',
      array_to_string(offenders, ', ');
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
revoke all on function public.adpop_authenticated_callable_functions() from public, anon, authenticated, service_role;
revoke all on function public.adpop_exposed_schemas() from public, anon, authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════
-- ⑥ allow-list に載っている関数を、anon へ**配り直す**(Codex 2巡目 Medium)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **なぜ要るか**: ② と ③ は流し直すたびに **anon から全部剥がす**。
--   PR2 で配信の関数を開けた後にこのファイルを流し直すと、**配信口が黙って止まる**
--   (マイグレーションは緑・テストも緑・気づくのは訪問者が減ってから)。
--   → **剥がした後に、宣言してある分だけを配り直す。**
-- ⚠ **「締める側を先に、開ける側を後に」の並びは崩れていない** ——
--   ここで開けるのは **allow-list に載っている分だけ**で、
--   途中で止まっても「宣言より広く開く」ことはない。
-- ⚠ PR1 では allow-list が空なので、このブロックは**1文も実行しない**。
--   (= いまは何も配り直していない。効き始めるのは PR2 から。)
do $$
declare
  sig text;
  ns  text;
begin
  foreach sig in array public.adpop_anon_callable_functions() loop
    select n.nspname into ns
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.oid = to_regprocedure(sig)::oid;
    -- 実在しない署名は関門(0)が落とすので、ここでは黙って飛ばす
    if ns is null then continue; end if;
    execute format('grant usage on schema %I to anon', ns);
    execute format('grant execute on function %s to anon', sig);
  end loop;
end $$;

select public.adpop_assert_privilege_rules();
