-- ADPOP 0006: **主張を、証明できる形に狭める** + 閉められるものを閉める(Codex 3巡目 Blocker)。
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴🔴 **「この資格で届くのは2関数だけ」は、3巡かけて証明できないと分かった**
-- ══════════════════════════════════════════════════════════════════════
-- 0004 は `/rest/v1` の `public` だけを測って「鍵で届くのは2関数」と書き、**Auth と Storage を見落とした**。
-- 0005 は「全スキーマで数え上げた」と書いたが、**数え上げを1つ足すたびに、数えていないものが1つ出た**:
--   型 / ドメイン、言語、テーブル空間、FDW、ラージオブジェクト、パラメータ、
--   データベースの CONNECT / TEMPORARY / CREATE、**PUBLIC 由来の基礎権限**……
--
-- ✅ **やめたのは「数え上げ」ではなく「全部数えたという言い方」。**
--   → 関門は **数える種別を名指し**し、**数えない種別も名指しする**(v4 の (g) の冒頭)。
--   → **閉められるものは閉め、閉めた結果を測る**((g8)(g9))。
--   → **閉められないものは「閉めていない」と書く**(PUBLIC の CONNECT・101本の PUBLIC 実行可能関数)。
--
-- 🔴 **これは後退ではない。** 「測った範囲より広く書く」を、**主張の側を直して**閉じる。

-- ══════════════════════════════════════════════════════════════════════
-- ① データベースそのものの権限
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **`TEMPORARY` を PUBLIC から外す。** 一時表は**資源を食う**うえ、配信の2関数には1ミリも要らない。
-- ⚠ **`CONNECT` は外さない。** 外すと**このデータベースの全ロールが繋げなくなり**、
--   後から Supabase が作るロールも巻き添えになる。しかも**買えるものが無い** ——
--   攻撃者は接続文字列(= パスワード)を持っている前提なので、`CONNECT` の有無は何も守らない。
--   → **外さないことを決めて、(g9) で「CONNECT は対象外」と分かる形にした。**
-- ⚠ `CREATE`(スキーマを作る)は**既に PUBLIC に無い**(2026-09-11 実測)。**在ると思って書かない。**
do $$
declare
  db text := current_database();
begin
  -- 配信ロールの CONNECT を **PUBLIC 由来ではなく明示**にする(PUBLIC が将来変わっても繋がる)
  execute format('grant connect on database %I to adpop_delivery', db);
  execute format('revoke temporary on database %I from public', db);
  execute format('revoke create on database %I from public', db);
end $$;

-- ══════════════════════════════════════════════════════════════════════
-- ② 文の上限は **ロールの既定**に置く
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **実測で3つ分かった**(2026-09-11):
--   ・**関数単位の `SET statement_timeout` は効かない** —— 300ms を設定した関数の中で
--     2秒の `pg_sleep` が**完走した**。タイマーは**最上位の文の開始時**に張られ、
--     途中で変えても**張り直されない**。
--   ・**ロールの既定は効く** —— 同じ sleep が `canceling statement due to statement timeout` で落ちた。
--   ・**クライアントが渡す起動時パラメータは当てにできない** ——
--     transaction pooler ではセッションが使い回されるので、渡した設定が残る保証が無い。
-- ⚠ したがって「5秒で切れる」と言えるのは**ここに置いた分だけ**。
--   クライアント側で保証できるのは **接続の待ち時間(`connect_timeout`)だけ**。
alter role adpop_delivery set statement_timeout = '5000ms';
alter role adpop_delivery set idle_in_transaction_session_timeout = '10000ms';
-- ⚠ 配信の2関数は読み書きとも一瞬で終わる。長くかかるのは**何かがおかしいとき**なので、短く切る。

-- ══════════════════════════════════════════════════════════════════════
-- ③ 関門を v4 へ(**数える種別を名指しし、数えない種別も名指しする**)
-- ══════════════════════════════════════════════════════════════════════
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
      → **資格を Postgres のロール1つに絞り、測る権限の種別を名指しする**((g) の冒頭)。
        ⚠ **「全部数えた」とは書かない**(2026-09-11 に撤回した。数え上げでは終わらないため)。
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
  v_timeout      text;
  v_timeout_ms   bigint;
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
    (g) 配信専用ロールの権限を測る —— **数える種別を名指しし、数えない種別も名指しする**
    ══════════════════════════════════════════════════════════════════════
    🔴🔴 **v3 までの書き方(「全スキーマで数え上げた」)をやめた**(2026-09-11 / Codex 3巡目)。
      3巡かけて分かったのは、**「この資格で届くのは2関数だけ」は証明できない**ということ。
      数え上げを1つ足すたびに、数えていないものが1つ見つかる形になっていた。

    ✅ **この関門が数える権限の種別(これだけ)**:
       ① 表・ビュー(SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN。列単位も)
       ② 連番(USAGE/SELECT/UPDATE)
       ③ 関数・プロシージャの EXECUTE
       ④ スキーマの USAGE / CREATE
       ⑤ データベースの CONNECT / TEMPORARY / CREATE
       ⑥ ロールのメンバー関係
       ⑦ ロールの属性(SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS/REPLICATION)
       ⑧ ロールの既定 GUC(statement_timeout)

    🔴 **PostgreSQL の権限種別は、これで全部ではない。** 数えていないもの(名前で挙げる):
       ・**型 / ドメインの USAGE** ・**言語(LANGUAGE)の USAGE**
       ・**テーブル空間の CREATE** ・**FDW / 外部サーバーの USAGE**
       ・**ラージオブジェクト** ・**パラメータ(ALTER SYSTEM)の SET/ALTER SYSTEM**
       ・**PUBLIC 由来の基礎権限**(下の ⚠ を見よ)
    🔴 **DB の外はもっと数えていない**: TLS の設定 / Supavisor(pooler)の設定 /
       `pg_hba.conf` / ネットワーク到達性。**マイグレーションからは測れない。**

    ⚠ **PUBLIC が既に持っているものは数えない** —— それは**全員が持つ地の権限**で、
      このロール固有ではない(`anon` も同じものを持つ)。ここで数えると、測りたい差が埋もれる。
      🔴 **したがって、この関門が言えるのは「PUBLIC の地の権限に、このロールが何を足されているか」だけ。**
      ⚠ 実測(2026-09-11・ローカル): **PUBLIC が EXECUTE できる非システム関数は 101 本**ある。
        これらは**剥がせない**(Supabase の拡張が持つ関数で、剥がすとプラットフォームが壊れる)。
        **剥がせないものを「閉じた」と書かない。**
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


  /*
    (g8) **データベースそのものの権限**。配信ロールが `CREATE`(スキーマを作る)や
      `TEMPORARY`(一時表を作る)を持たない。
    ⚠ `CONNECT` は**持っていてよい**(持っていないと繋げない)。
      ただし **PUBLIC 由来ではなく、明示の grant で**持たせる(0006)。
  */
  select coalesce(array_agg(p order by p), '{}') into offenders
  from unnest(array['CREATE', 'TEMPORARY']) as p
  where has_database_privilege(delivery_role, current_database(), p)
    -- ⚠ 他の (g) と同じ規約: **PUBLIC が持っている分は数えない**(全員が持つ地の権限で、固有ではない)。
    --   PUBLIC 側が持っていないことは (g9) が別に測る。**2つを混ぜると、どちらが守っているか分からなくなる。**
    and not has_database_privilege('public', current_database(), p);
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g8): 配信ロールがデータベースの権限を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  /*
    (g9) 🔴 **閉めた結果を測る。** データベースの `TEMPORARY` と `CREATE` を PUBLIC から外した(0006)。
      ⚠ **`CONNECT` は PUBLIC から外していない** —— 外すと**このデータベースの全ロールが繋げなくなり**、
        後から Supabase が作るロールも巻き添えになる。**買えるものが無いのに壊す**ので、やらない。
        (攻撃者はパスワードを持っている前提なので、`CONNECT` の有無は何も守らない。)
      🔴 **「閉じていない」ことを、閉じたふりをせずここで固定する。**
  */
  select coalesce(array_agg(p order by p), '{}') into offenders
  from unnest(array['CREATE', 'TEMPORARY']) as p
  where has_database_privilege('public', current_database(), p);
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g9): PUBLIC がデータベースの権限を持っています: %',
      array_to_string(offenders, ', ');
  end if;

  /*
    (g10) **配信ロールに文の上限が載っている**こと。
    🔴 **実測でここに落ち着いた**(2026-09-11):
      ・**関数単位の `SET statement_timeout` は効かない** —— 300ms を設定した関数の中で
        2秒の `pg_sleep` が**完走した**。タイマーは**最上位の文の開始時**に張られ、途中の変更では張り直されない。
      ・**ロールの既定は効く** —— 同じ 2秒の sleep が `canceling statement due to statement timeout` で落ちた。
    ⚠ **クライアントが渡す起動時パラメータは当てにしない** ——
      transaction pooler では**セッションが使い回される**ので、渡した設定が残る保証が無い。
  */
  select cfg into v_timeout
  from pg_catalog.pg_roles r
  cross join lateral unnest(coalesce(r.rolconfig, '{}'::text[])) as cfg
  where r.rolname = delivery_role and cfg like 'statement_timeout=%';
  if v_timeout is null then
    raise exception 'ADPOP 権限の関門(g10): 配信ロールに statement_timeout の既定がありません';
  end if;
  /*
    🔴 **「載っている」だけを見ると `0`(= 無制限)も通る**(Codex 4巡目)。
      `statement_timeout=0` は PostgreSQL では**上限なし**。**値まで比べる。**
    ⚠ 単位は付けても付けなくてもよい(付けなければミリ秒)。**3つの書き方を同じ土俵に乗せる。**
  */
  v_timeout_ms := case
    when v_timeout ~ '^statement_timeout=[0-9]+ms$'  then substring(v_timeout from '([0-9]+)ms$')::bigint
    when v_timeout ~ '^statement_timeout=[0-9]+s$'   then substring(v_timeout from '([0-9]+)s$')::bigint * 1000
    when v_timeout ~ '^statement_timeout=[0-9]+min$' then substring(v_timeout from '([0-9]+)min$')::bigint * 60000
    when v_timeout ~ '^statement_timeout=[0-9]+$'    then substring(v_timeout from '([0-9]+)$')::bigint
    else null
  end;
  if v_timeout_ms is null then
    raise exception 'ADPOP 権限の関門(g10): statement_timeout の値を読めません(%)。ms / s / min か、単位なしで書いてください', v_timeout;
  end if;
  if v_timeout_ms <= 0 or v_timeout_ms > 30000 then
    raise exception 'ADPOP 権限の関門(g10): statement_timeout が範囲外です(% = % ms)。0 は無制限なので通しません', v_timeout, v_timeout_ms;
  end if;

  /*
    (g11) **どのスキーマにも `CREATE` を持たない**(スキーマの中に表や関数を作れない)。
    ⚠ (e2) は `adpop_exposed_schemas()` の中しか見ない。ここは**その外まで**見る。
  */
  select coalesce(array_agg(n.nspname order by n.nspname), '{}') into offenders
  from pg_catalog.pg_namespace n
  where n.nspname not in ('pg_catalog', 'information_schema')
    and has_schema_privilege(delivery_role, n.oid, 'CREATE')
    and not has_schema_privilege('public', n.oid, 'CREATE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(g11): 配信ロールがスキーマの CREATE を持っています: %',
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
  'ADPOP 権限の関門 v4。数える権限の種別を (g) の冒頭に名指しし、数えない種別も名指ししてある。いまの正はこの定義(0006)。';
revoke all on function public.adpop_assert_privilege_rules()
  from public, anon, authenticated, service_role, adpop_delivery;

select public.adpop_assert_privilege_rules();
