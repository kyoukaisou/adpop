-- ADPOP 0005: **配信の口を叩く資格を、専用の Postgres ロール1つに絞る**(Codex 2巡目 Blocker 1・2)。
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴🔴 **0004 の判断が誤りだった。実測で覆った。**
-- ══════════════════════════════════════════════════════════════════════
-- 0004 は「サーバーは `service_role` の鍵で呼ぶ。**その鍵で届くのは関数2本だけ**」と書いた。
-- **その主張は、測っていない範囲を含んでいた。**
--   ・こちらが測っていたのは **`/rest/v1` の `public` スキーマだけ**
--   ・`service_role` の鍵は **Auth Admin API と Storage API にも通る**(どちらも `/rest/v1` の外)
--
-- 🔴 **自分で撃って確かめた**(ローカルの本物のスタック・2026-09-11):
--   ・`POST /auth/v1/admin/users` …… anon = **403** / service_role = **200(利用者が作られる)**
--   ・`DELETE /auth/v1/admin/users/<id>` …… service_role = **200**
--   → `sites.owner_id` は `auth.users` へ **on delete cascade** なので、
--     **鍵1本で管理者ごと、サイト・ポップ・バリアント・イベントが全部消えた**
--     (実測: 1 sites / 1 popups / 1 variants → **0 / 0 / 0**)。
--
-- 📌 **教訓**: **「この鍵で届く範囲」を、測った範囲より広く書いてはいけない。**
--   関門も検査も `public` しか見ていなかったのに、主張は鍵全体について語っていた。
--
-- ══════════════════════════════════════════════════════════════════════
-- 採った形 = **(b) PostgREST を経由しない。専用の Postgres ロールで DB へ直接つなぐ**
-- ══════════════════════════════════════════════════════════════════════
-- ・**Auth も Storage も経路に存在しなくなる**ので、この型の穴が**構造ごと**消える
-- ・資格は **Postgres のロール1つ**になるので、**権限を全スキーマにわたって数え上げられる**
--   → 下の関門(g1)〜(g7)が、**まさにそれ**を毎回測る。**主張と測る範囲が一致する。**
--
-- 🔴 **鍵(接続文字列)が漏れたら何ができるか**: **この2つの関数を呼べるだけ**。
--   表・連番には**全スキーマで**権限ゼロ / **全スキーマで** allow-list の外の関数を実行できない /
--   他のロールのメンバーでない / SUPERUSER・CREATEROLE・CREATEDB・BYPASSRLS・REPLICATION を持たない。
--   **どれも関門(g1)〜(g7)が毎回測る**(「測っていない範囲」を残さない)。
--   ⚠ **測っていない範囲を1つだけ正直に書く**: **Postgres のサーバー設定そのもの**
--     (`pg_hba` / ネットワーク到達性)は、こちらのマイグレーションからは測れない。
--   ⚠ **それでも「配信の関数を無制限に呼べる」ことは残る** —— サイトキーと許可 Origin を
--     知っていれば、イベントを好きなだけ入れられる(要件書 §4-7「イベントは誰でも偽造できる」の範囲)。
--
-- ⚠ **採らなかった案 (a)(専用ロール + Supabase の API キー)**:
--   Supabase の secret key を**特定の Postgres ロールに紐づけられるか**を
--   **一次情報で確認できなかった**(この作業では外部の資料に到達できなかった)。
--   自前で JWT を署名する経路は動くが、**Supabase が旧 JWT secret を非推奨にしつつある**ので
--   「いま動いて後で壊れる」。**確認できないものを前提にしない**ため (b) を採った。
--
-- 🔴 **このファイルは再実行できる。**
-- 🔴 **並びの規則**: 締める側を先に、開ける側を後に。

-- ══════════════════════════════════════════════════════════════════════
-- ① 配信専用のロール
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠ **パスワードはここで設定しない。** マイグレーションに書くと**リポジトリに秘密が入る**うえ、
--   本番にも同じ値が流れる。→ **作るだけ作って、パスワードは運用側で設定する**(README)。
--   パスワードが設定されるまで**このロールでは接続できない**(= fail-closed)。
-- ⚠ `noinherit`: 将来だれかがこのロールを別のロールのメンバーにしても、
--   **黙って権限が増えない**(明示的に `set role` しない限り継承しない)。
--   ⚠ そもそもメンバーにさせないことは、関門(g4)が測る。
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'adpop_delivery') then
    create role adpop_delivery login noinherit;
  end if;
end $$;

comment on role adpop_delivery is
  'ADPOP の配信エンドポイント専用。許されるのは adpop_delivery_callable_functions() の関数だけ。パスワードは運用側で設定する。';

-- 🔴 まず全部剥がす(このロールに何が付いていても、ここで0に戻す)
revoke all on all tables in schema public from adpop_delivery;
revoke all on all sequences in schema public from adpop_delivery;
revoke all on all functions in schema public from adpop_delivery;
revoke all on schema public from adpop_delivery;
/*
  ⚠ **他のスキーマ(`auth` / `storage` / `vault` …)は、剥がそうとしない。**
    🔴 最初はここで `revoke all on all functions in schema vault from adpop_delivery` まで書いたが、
      **`permission denied for function _crypto_aead_det_encrypt` で適用が落ちた**(2026-09-11 実測)。
      マイグレーションを流す `postgres` は **Supabase が持つオブジェクトの所有者ではない**ので、
      そもそも revoke できない(所有していない数千のオブジェクトに WARNING を出した末に落ちる)。
    🔴 **「剥がしたつもり」を書くほうが危ない。** 剥がせていないのに剥がした顔をする文が残ると、
      **次に読む人が「ここは閉じている」と読む**。
    ✅ **剥がすのをやめ、代わりに「持っていないこと」を毎回測る**(関門(g1)〜(g6))。
      測るのは**全スキーマ**で、`public` に限らない —— **これが v2 の誤りへの直接の対処**。
      余分な権限が付いていたら、**マイグレーションの適用そのものが止まる**。
*/

-- ══════════════════════════════════════════════════════════════════════
-- ② allow-list の宣言
-- ══════════════════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.adpop_delivery_callable_functions()') is null then
    execute $q$
      create function public.adpop_delivery_callable_functions()
      returns text[] language sql immutable as $body$ select '{}'::text[] $body$;
    $q$;
  end if;
end $$;

create or replace function public.adpop_delivery_callable_functions()
returns text[] language sql immutable as $$
  select array[
    'public.adpop_site_config(text, text)',
    'public.adpop_record_event(text, text, jsonb)'
  ]::text[];
$$;

comment on function public.adpop_delivery_callable_functions() is
  '配信専用ロール(adpop_delivery)が EXECUTE を持ってよい関数。ここに無いものを呼べたら関門が落ちる。';

-- 🔴 **`service_role` からは取り上げる**(0004 で配ったものを戻す)。
--   ⚠ 宣言を空にするだけでは足りない —— **実際に revoke する**。
create or replace function public.adpop_service_callable_functions()
returns text[] language sql immutable as $$ select '{}'::text[] $$;

revoke all on function public.adpop_site_config(text, text)          from service_role;
revoke all on function public.adpop_record_event(text, text, jsonb)  from service_role;
revoke usage on schema public from service_role;

revoke all on function public.adpop_delivery_callable_functions()
  from public, anon, authenticated, service_role, adpop_delivery;
revoke all on function public.adpop_service_callable_functions()
  from public, anon, authenticated, service_role, adpop_delivery;
revoke all on function public.adpop_anon_callable_functions()
  from public, anon, authenticated, service_role, adpop_delivery;
revoke all on function public.adpop_authenticated_callable_functions()
  from public, anon, authenticated, service_role, adpop_delivery;
revoke all on function public.adpop_exposed_schemas()
  from public, anon, authenticated, service_role, adpop_delivery;
revoke all on function public.adpop_assert_privilege_rules()
  from public, anon, authenticated, service_role, adpop_delivery;

-- ══════════════════════════════════════════════════════════════════════
-- ③ 関門を v3 へ(**適用済みの DB にも届く形で置き直す**)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 関門の「いまの正」は、いつも最も新しいマイグレーションが持つ(0004 と同じ作法)。
-- 🔴 **v3 で足したのは (g1)〜(g7)** —— 配信ロールの権限を **`public` ではなく全スキーマ**で数え、
--   さらに **配信の関数を配信ロール以外に実行させない**((g7))。
--   **これが v2 の誤り(測る範囲より広い主張)への直接の対処。**
create or replace function public.adpop_assert_privilege_rules()
returns void
language plpgsql
as $rules$
declare
  -- MAINTAIN は PostgreSQL 17 で追加された。16 以下に渡すと引数エラーになるので版で切り替える。
  is_pg17    constant boolean := current_setting('server_version_num')::int >= 170000;
  table_privs text[] := case when is_pg17
                          then array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
                          else array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] end;
  -- 列単位の grant が在りうる権限。
  -- ⚠ `has_table_privilege` は**列単位の grant を映さない**(2026-09-08 実測)。
  --   `grant select (site_key) on sites to anon` は表単位では偽になるので、両方で測る。
  column_privs constant text[] := array['SELECT','INSERT','UPDATE','REFERENCES'];
  extra_privs  text[] := case when is_pg17
                          then array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
                          else array['TRUNCATE','REFERENCES','TRIGGER'] end;
  -- 🔴 関門が見るスキーマ。**ここだけが集合を持つ**(catalog を引く検査は全部これを使う)。
  exposed      constant text[] := public.adpop_exposed_schemas();
  allowed         constant text[] := public.adpop_anon_callable_functions();
  allowed_auth    constant text[] := public.adpop_authenticated_callable_functions();
  /*
    🔴 **v2 で足した軸**: 配信の口は **anon ではなく service_role** から呼ぶ形にした(0004)。
      ⚠ 「anon より広い鍵を使う」のではない —— **service_role の実効権限は、
        ここに宣言した関数だけ**であることを、この関門が毎回測る((c) と下の (e3s)(e4s))。
  */
  allowed_service constant text[] := public.adpop_service_callable_functions();
  /*
    🔴🔴 **v3(0005)**: 配信の口は **`service_role` の鍵ではなく、専用の Postgres ロール**から呼ぶ。
      ⚠ v2 は「service_role の実効権限は関数2本だけ」と書いたが、**測っていたのは
        `/rest/v1` の `public` だけ**で、**Auth Admin API と Storage には通っていた**(実測で判明)。
      → **資格を Postgres のロール1つに絞り、その権限を全スキーマで数え上げる**((g1)〜(g6))。
  */
  delivery_role    constant text   := 'adpop_delivery';
  allowed_delivery constant text[] := public.adpop_delivery_callable_functions();
  /*
    🔴 **allow-list は文字列ではなく OID で突き合わせる**(2026-09-08 実測)。
      `oid::regprocedure::text` は **search_path 依存**で、public が search_path に在ると
      `public.` が落ちて `adpop_is_https_url(text)` になる。
      文字列で比べると、**流す環境の search_path で allow-list が黙って効かなくなる。**
    ⚠ 解決できない署名(誤記・消した関数)は**その場で落とす**。
      放っておくと「allow-list が空になった」= 一見 fail-closed だが、
      **なぜ落ちたのかが誰にも分からない**形で関門が鳴る。
  */
  allowed_oids         oid[];
  allowed_auth_oids    oid[];
  allowed_service_oids  oid[];
  allowed_delivery_oids oid[];
  unresolved        text[];
  offenders   text[];
  probe_tbl   constant text := 'zz_adpop_privilege_probe_tbl';
  probe_seq   constant text := 'zz_adpop_privilege_probe_seq';
  probe_fn    constant text := 'zz_adpop_privilege_probe_fn';
  probe_ns    text;
begin
  -- (0) allow-list の署名を OID に解決する。解決できないものが1つでもあれば落とす。
  select coalesce(array_agg(sig order by sig), '{}') into unresolved
  from unnest(allowed || allowed_auth || allowed_service || allowed_delivery) as sig
  where to_regprocedure(sig) is null;
  if array_length(unresolved, 1) is not null then
    raise exception 'ADPOP 権限の関門(0): allow-list に、実在しない関数の署名があります: %',
      array_to_string(unresolved, ', ');
  end if;
  select coalesce(array_agg(to_regprocedure(sig)::oid), '{}') into allowed_oids
  from unnest(allowed) as sig;
  select coalesce(array_agg(to_regprocedure(sig)::oid), '{}') into allowed_auth_oids
  from unnest(allowed_auth) as sig;
  select coalesce(array_agg(to_regprocedure(sig)::oid), '{}') into allowed_service_oids
  from unnest(allowed_service) as sig;
  select coalesce(array_agg(to_regprocedure(sig)::oid), '{}') into allowed_delivery_oids
  from unnest(allowed_delivery) as sig;

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
  from unnest(allowed || allowed_auth || allowed_service || allowed_delivery) as sig
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
    cross join (values ('anon'), ('service_role'), ('public'), ('adpop_delivery')) ro(g)
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
    cross join (values ('anon'), ('service_role'), ('public'), ('adpop_delivery')) ro(g)
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
    cross join (values ('anon'), ('authenticated'), ('service_role'), ('public'), ('adpop_delivery')) ro(g)
    where n.nspname = any (exposed)
      and has_function_privilege(ro.g, p.oid, 'EXECUTE')
      and not (ro.g = 'anon' and p.oid = any (allowed_oids))
      and not (ro.g = 'authenticated' and p.oid = any (allowed_auth_oids))
      -- 🔴 v2: 配信の口は service_role から呼ぶ。**宣言した分だけ**を許す
      and not (ro.g = 'service_role' and p.oid = any (allowed_service_oids))
      and not (ro.g = delivery_role and p.oid = any (allowed_delivery_oids))
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
    (e) スキーマの権限。anon の USAGE は「**そのスキーマに allow-list の関数が在るとき**」だけ許す。
    ⚠ USAGE 単体では何も触れないが、**入口を開ける理由が無いのに開いている状態**を残さない。
    🔴 **`public` 固定をやめて集合で回す**(Codex 3巡目 Medium)。
      `adpop_exposed_schemas()` を増やしても、増やしたスキーマの anon USAGE と CREATE を
      1つも見ていなかった = **2巡目に直した型(集合が別の場所で育つ)の、直し残し**。
    🔴🔴 **判定を「allow-list 全体が空か」から「このスキーマに1本でも在るか」に変えた**
      (2026-09-09 / PR2)。**PR1 の書き方は、allow-list が空でなくなった瞬間に
      1つのスキーマも落とさなくなる** —— PR2 で配信の関数を2本足したので、
      `array_length(allowed, 1) is null` は**恒偽**になり、この関門は丸ごと空回りに変わっていた。
      ⚠ **守りは正しいまま、測る対象が消える**型。テストのコードは1文字も変わらないので、
        差分レビューにも出ない。
      ✅ **スキーマごとに「そこに allow-list の関数が在るか」で見る**と、
        集合が増えても・allow-list が埋まっても、判定の意味が変わらない。
  */
  select coalesce(array_agg(ns order by ns), '{}') into offenders
  from unnest(exposed) as ns
  where has_schema_privilege('anon', ns, 'USAGE')
    and not exists (
      select 1
      from unnest(allowed) as sig
      join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ns
    );
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e): anon から呼べる関数が1本も無いのに、anon が USAGE を持つスキーマがあります: %',
      array_to_string(offenders, ', ');
  end if;

  -- (es) 同じ規則を**配信専用ロール**にも当てる(v3 で配信の口がこちらへ移ったため)
  select coalesce(array_agg(ns order by ns), '{}') into offenders
  from unnest(exposed) as ns
  where has_schema_privilege(delivery_role, ns, 'USAGE')
    and not exists (
      select 1
      from unnest(allowed_delivery) as sig
      join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ns
    );
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(es): 配信ロールから呼べる関数が1本も無いのに、配信ロールが USAGE を持つスキーマがあります: %',
      array_to_string(offenders, ', ');
  end if;

  select coalesce(array_agg(format('%s|%s', ns, ro.g) order by 1), '{}') into offenders
  from unnest(exposed) as ns
  cross join (values ('anon'), ('authenticated'), ('service_role'), ('public'), ('adpop_delivery')) ro(g)
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

  /*
    (e3s)(e4s) 🔴 **配り漏れの向きを service_role でも見る。**
      0001 の ② と ③ は流し直すたびに service_role からも剥がすが、
      0001 の ⑥ は **anon の allow-list ぶんしか配り直さない**(0001 は service_role を知らない)。
      → **0001 を流し直したら、ここが止める。**静かに配信が死ぬのではなく、適用が失敗する。
      ⚠ 直し方は「最新のマイグレーションも流し直す」。例外文にそう書く。
  */
  select coalesce(array_agg(sig order by sig), '{}') into offenders
  from unnest(allowed_delivery) as sig
  where not has_function_privilege(delivery_role, to_regprocedure(sig), 'EXECUTE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e3s): allow-list に載っているのに配信ロールが実行できない関数があります(0001 を流し直したなら、最新のマイグレーションも流し直してください): %',
      array_to_string(offenders, ', ');
  end if;

  select coalesce(array_agg(distinct ns order by ns), '{}') into offenders
  from (
    select n.nspname as ns
    from unnest(allowed_delivery) as sig
    join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  ) s
  where not has_schema_privilege(delivery_role, ns, 'USAGE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e4s): allow-list の関数が在るスキーマの USAGE を配信ロールが持っていません(0001 を流し直したなら、最新のマイグレーションも流し直してください): %',
      array_to_string(offenders, ', ');
  end if;


  /*
    ══════════════════════════════════════════════════════════════════════
    (g) 🔴🔴 **配信専用ロールの権限を、`public` ではなく「全スキーマ」で数え上げる**
    ══════════════════════════════════════════════════════════════════════
    🔴 **v2 の誤りの本体はここだった。** 「この資格で届くのは関数2本だけ」と書きながら、
      測っていたのは **`public` スキーマだけ**。`service_role` の鍵は
      **Auth Admin API と Storage API に通っていた**(2026-09-11 実測。利用者を作成・削除でき、
      `sites.owner_id` の cascade で配下データが全部消えた)。
    ✅ **資格を Postgres のロールにしたので、権限を全部数え上げられる。**
      **主張の範囲と、測る範囲を一致させる。**

    ⚠ **数えないもの(理由つき)**:
      ・`pg_catalog` / `information_schema` …… PostgreSQL が全員に配る地の部分
      ・**PUBLIC が既に持っているもの** …… それは**全員が持つ**ので、このロール固有ではない
        (`anon` も同じものを持つ。ここで数えると、測りたい差が埋もれる)
      🔴 したがってここが測るのは「**PUBLIC の地の権限に、このロールが何を足されているか**」。
  */
  -- (g1) どのスキーマの表・ビューにも、PUBLIC を超える権限を持たない
  select coalesce(array_agg(format('%s|%s', rel, priv) order by 1), '{}') into offenders
  from (
    select c.oid::regclass::text as rel, p as priv
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join unnest(table_privs) as p
    where n.nspname not in ('pg_catalog', 'information_schema')
      and c.relkind in ('r','v','m','p','f')
      and (has_table_privilege(delivery_role, c.oid, p)
           or (p = any (column_privs) and has_any_column_privilege(delivery_role, c.oid, p)))
      and not (has_table_privilege('public', c.oid, p)
               or (p = any (column_privs) and has_any_column_privilege('public', c.oid, p)))
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g1): 配信ロールが表に権限を持っています(スキーマを問わず): %',
      array_to_string(offenders, ', ');
  end if;

  -- (g2) 連番も同じ
  select coalesce(array_agg(format('%s|%s', rel, priv) order by 1), '{}') into offenders
  from (
    select c.oid::regclass::text as rel, p as priv
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['USAGE','SELECT','UPDATE']) as p
    where n.nspname not in ('pg_catalog', 'information_schema')
      and c.relkind = 'S'
      and has_sequence_privilege(delivery_role, c.oid, p)
      and not has_sequence_privilege('public', c.oid, p)
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g2): 配信ロールが連番に権限を持っています(スキーマを問わず): %',
      array_to_string(offenders, ', ');
  end if;

  -- (g3) 実行できる関数は allow-list の分だけ(スキーマを問わず)
  select coalesce(array_agg(fn order by fn), '{}') into offenders
  from (
    select p.oid::regprocedure::text as fn
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and has_function_privilege(delivery_role, p.oid, 'EXECUTE')
      and not has_function_privilege('public', p.oid, 'EXECUTE')
      and not (p.oid = any (allowed_delivery_oids))
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g3): 配信ロールが allow-list の外の関数を実行できます(スキーマを問わず): %',
      array_to_string(offenders, ', ');
  end if;

  -- (g4) 他のロールのメンバーでない(**メンバーになると権限が黙って増える**)
  select coalesce(array_agg(r.rolname order by r.rolname), '{}') into offenders
  from pg_catalog.pg_auth_members m
  join pg_catalog.pg_roles r on r.oid = m.roleid
  where m.member = (select oid from pg_catalog.pg_roles where rolname = delivery_role);
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g4): 配信ロールが他のロールのメンバーになっています: %',
      array_to_string(offenders, ', ');
  end if;

  -- (g5) 強い属性を1つも持たない
  select coalesce(array_agg(flag order by flag), '{}') into offenders
  from pg_catalog.pg_roles r
  cross join lateral (values
    ('SUPERUSER', r.rolsuper), ('CREATEROLE', r.rolcreaterole), ('CREATEDB', r.rolcreatedb),
    ('BYPASSRLS', r.rolbypassrls), ('REPLICATION', r.rolreplication)
  ) as f(flag, on_)
  where r.rolname = delivery_role and f.on_;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g5): 配信ロールが強い属性を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  -- (g6) USAGE を持ってよいスキーマは、allow-list の関数が在るところだけ(スキーマを問わず)
  select coalesce(array_agg(n.nspname order by n.nspname), '{}') into offenders
  from pg_catalog.pg_namespace n
  where n.nspname not in ('pg_catalog', 'information_schema')
    and has_schema_privilege(delivery_role, n.oid, 'USAGE')
    and not has_schema_privilege('public', n.oid, 'USAGE')
    and not exists (
      select 1
      from unnest(allowed_delivery) as sig
      join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
      where p.pronamespace = n.oid
    );
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g6): 配信ロールが、使い道の無いスキーマの USAGE を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  /*
    (g7) 🔴🔴 **配信の関数は、配信ロール以外の誰にも実行させない。**
      ⚠ (c) は「allow-list に載っていれば許す」なので、**allow-list を書き換えれば通ってしまう**。
        実際、**追い越された 0003 を流し直すと**「anon の allow-list に2本を載せて anon へ配る」が
        再現され、**(c) は何も言わない**(宣言と実効が一致してしまうため)。
        = **誰でも直接叩ける構造が、黙って戻る。**
      ✅ **allow-list の書き換えでは外せない不変条件**として、ここで別に縛る。
        「この2本を実行してよいのは配信ロールだけ」。
  */
  select coalesce(array_agg(format('%s|%s', fn, grantee) order by 1), '{}') into offenders
  from (
    select p.oid::regprocedure::text as fn, ro.g as grantee
    from unnest(allowed_delivery) as sig
    join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
    cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
    where has_function_privilege(ro.g, p.oid, 'EXECUTE')
  ) s;
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g7): 配信の関数を、配信ロール以外が実行できます: %',
      array_to_string(offenders, ', ');
  end if;

  -- (f) **これから作られるもの**に権限が配られない(実際に作って測り、消す)
  --     ⚠ **(d) より後に置く。** ここで作る検査用の表は RLS を有効にしないので、
  --       (d) の前に作ると「RLS が無効な表が在る」で自分自身に落とされる。
  --       ⚠ 並べ替えるときはここを読むこと(順序が意味を持っている)。
  /*
    🔴🔴 **v2: probe を `public` にしか作っていなかった**(Codex 1巡目 sol Medium)。
      `adpop_exposed_schemas()` を広げても、**広げたスキーマの既定privilege は1つも見ていなかった**
      = 2巡かけて直した「集合が別の場所で育つ」型の、**(f) だけ残っていた分**。
    ✅ **exposed の1つ1つに probe を作って測り、すぐ消す。**
    ⚠ ここは (d) より後に置く(probe の表は RLS を有効にしないので、(d) の前だと自分に落とされる)。
  */
  foreach probe_ns in array exposed loop
    execute format('create table %I.%I (id integer)', probe_ns, probe_tbl);
    execute format('create sequence %I.%I', probe_ns, probe_seq);
    execute format('create function %I.%I() returns integer language sql as $probe$select 1$probe$', probe_ns, probe_fn);

    select coalesce(array_agg(format('table|%s|%s', grantee, priv) order by 1), '{}')
      into offenders
    from (
      select ro.g as grantee, p as priv
      from (values ('anon'), ('authenticated'), ('service_role'), ('public'), ('adpop_delivery')) ro(g)
      cross join unnest(table_privs) as p
      where has_table_privilege(ro.g, format('%I.%I', probe_ns, probe_tbl)::regclass, p)
    ) s;
    if array_length(offenders, 1) is not null then
      raise exception 'ADPOP 権限の関門(f-1): [%] 新しく作られる表に権限が配られます: %', probe_ns, array_to_string(offenders, ', ');
    end if;

    select coalesce(array_agg(format('sequence|%s|%s', grantee, priv) order by 1), '{}')
      into offenders
    from (
      select ro.g as grantee, p as priv
      from (values ('anon'), ('authenticated'), ('service_role'), ('public'), ('adpop_delivery')) ro(g)
      cross join unnest(array['USAGE','SELECT','UPDATE']) as p
      where has_sequence_privilege(ro.g, format('%I.%I', probe_ns, probe_seq)::regclass, p)
    ) s;
    if array_length(offenders, 1) is not null then
      raise exception 'ADPOP 権限の関門(f-2): [%] 新しく作られる連番に権限が配られます: %', probe_ns, array_to_string(offenders, ', ');
    end if;

    select coalesce(array_agg(format('function|%s', grantee) order by 1), '{}')
      into offenders
    from (
      select ro.g as grantee
      from (values ('anon'), ('authenticated'), ('service_role'), ('public'), ('adpop_delivery')) ro(g)
      where has_function_privilege(ro.g, format('%I.%I()', probe_ns, probe_fn)::regprocedure, 'EXECUTE')
    ) s;
    if array_length(offenders, 1) is not null then
      raise exception 'ADPOP 権限の関門(f-3): [%] 新しく作られる関数を業務ロールが実行できます: %', probe_ns, array_to_string(offenders, ', ');
    end if;

    execute format('drop function %I.%I()', probe_ns, probe_fn);
    execute format('drop sequence %I.%I', probe_ns, probe_seq);
    execute format('drop table %I.%I', probe_ns, probe_tbl);
  end loop;
end;
$rules$;

comment on function public.adpop_assert_privilege_rules() is
  'ADPOP 権限の関門 v3。書いた SQL ではなく実効の権限を測る。配信ロールの権限は全スキーマで数える。いまの正はこの定義(0005)。';
revoke all on function public.adpop_assert_privilege_rules()
  from public, anon, authenticated, service_role, adpop_delivery;

-- ══════════════════════════════════════════════════════════════════════
-- ④ 開ける(配信専用ロールにだけ配る)
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠ **表への grant は1文も無い。** 配信ロールが表・連番・他の関数・他のスキーマに
--   1つも権限を持たないことは、関門(g1)〜(g6) が**全スキーマで**測る。
grant usage on schema public to adpop_delivery;
grant execute on function public.adpop_site_config(text, text)         to adpop_delivery;
grant execute on function public.adpop_record_event(text, text, jsonb) to adpop_delivery;

select public.adpop_assert_privilege_rules();
