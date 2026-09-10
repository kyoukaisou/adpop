-- ADPOP 0004: **配信の口を「誰でも直接叩ける」構造からやめる** + Codex 1巡目の指摘を積む。
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴🔴 いちばん大きい変更: **anon から RPC を直接呼べる構造をやめた**
-- ══════════════════════════════════════════════════════════════════════
-- 0003 は `anon` に配信の関数2本の EXECUTE を配っていた。**PostgREST は
-- `/rest/v1/rpc/<関数名>` を公開する**ので、誰でも `anon` キーで直接叩けた。
-- → **Next.js のルートに置いた守り(本文 4KB の上限・将来のレート制限)を丸ごと迂回できる。**
--   ⚠ Origin の偽造は**この変更でも防げない**(そもそも `curl` に対しては何も守っていない。
--     Origin が守るのは「他人が自分の LP にタグを貼った」場合だけ = ブラウザが本物を送る場合)。
--     🔴 **直ったのは「限界がルートにしか無い」ほう**で、「Origin を名乗れる」ほうではない。
--
-- **採った形**: `anon` から EXECUTE と schema USAGE を剥がし、**`service_role` にだけ配る**。
--   サーバー(Next.js のルート)が `service_role` の鍵で呼ぶ = **入口が1つになる**。
--
-- ⚠ **「バイパス鍵を持ち込んだ」ように見えるので、実効の権限をここに書く**:
--   ・`service_role` は **6つの業務テーブルに権限を1つも持たない**(関門(a)(a2)(b) が毎回測る。
--     実物の PostgREST でも 403/42501 を実測している)
--   ・`service_role` が EXECUTE を持ってよい関数は **下の allow-list に宣言した2本だけ**(関門(c))
--   ・したがって鍵が漏れても届くのは **その2本**で、2本とも**自分で認可をしている**
--     (サイトキー × Origin × 許可ドメイン)。**RLS を迂回して表に届く経路は無い。**
--   🔴 **認可は引き続き DB に在る。** アプリ側へ持ち出していない。
--     この鍵は「認可の代わり」ではなく「**その関数に届くための切符**」。
--   ⚠ 採らなかった案: ①専用ロール + 自前 JWT(いちばん狭いが、Supabase が
--     旧 JWT secret を非推奨にしつつあり「いま動いて後で壊れる」)②直接 Postgres 接続
--     (依存とロールのパスワード管理が増え、自前ホストの手順が重くなる)。
--
-- 🔴 **このファイルは再実行できる**(0003 と同じ理由)。
-- 🔴 **並びの規則**: 締める側を先に、開ける側を後に。
--   ①関数の作り直し(権限は変えない)→ ②allow-list の宣言 → ③anon から剥がす →
--   ④関門を v2 へ → ⑤service_role へ配る → ⑥関門を呼ぶ。

-- ══════════════════════════════════════════════════════════════════════
-- ① 許可 Origin の配列に NULL を入れさせない(Codex 1巡目 Astra High)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **何が起きていたか**: `adpop_is_origin_list` は `bool_and` で判定していたが、
--   **集約関数は NULL の入力を無視する**ので `array['https://a.example.com', null]` が**保存できた**。
--   そして判定側の `p_origin = any (allowed_origins)` は、一致する要素が無くて NULL 要素が在ると
--   **false ではなく NULL** を返す。`if not NULL then` は**成立しない**ので、
--   **未許可の Origin がそのまま通っていた**(= 誰の LP に貼っても設定が返る)。
-- ✅ **入口(列制約)と判定(比較)の両方**を閉じる。片方だけだと、既存行や別経路で崩れる。
create or replace function public.adpop_is_origin_list(origins text[])
returns boolean
language sql
immutable
as $$
  select origins is not null
     -- ⚠ **空配列の `array_ndims` は 1 ではなく NULL**(2026-09-10 実測)。
     --   `is not distinct from 1` と書くと**許可ドメイン未設定のサイトを1件も作れなくなる**。
     and (array_ndims(origins) is null or array_ndims(origins) = 1)
     -- 🔴 NULL 要素を1つも許さない(⚠ `array_position` は多次元配列で例外を投げるので、上の判定が先)
     and array_position(origins, null) is null
     and coalesce((select bool_and(public.adpop_is_origin(o)) from unnest(origins) as o), true)
$$;

-- ⚠ 列制約としても独立に置く。**`adpop_is_origin_list` を将来書き換えた人が、
--   NULL 要素の扱いを落としても、こちらが止める。**(変異検査で片方ずつ殺せることを確認済み)
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.sites'::regclass and conname = 'sites_allowed_origins_no_null'
  ) then
    alter table public.sites add constraint sites_allowed_origins_no_null
      check (allowed_origins is not null and array_position(allowed_origins, null) is null);
  end if;
end $$;

-- ══════════════════════════════════════════════════════════════════════
-- ② 重複排除のキーに site を含める(Codex 1巡目 Astra Medium)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **何が起きていたか**: 一意索引が `(impression_id, kind)` で**全サイト共通**だった。
--   自分のサイト経由で他サイトの `impression_id` を先に入れると、
--   **他サイトの正規の表示イベントが `on conflict do nothing` で黙って落ちる**
--   = **他人の数字を減らせる**。⚠ 表示 ID は乱数なので当てるのは難しいが、
--   **観測できた ID(自分でテストした LP の値など)には効く**。
-- ✅ キーを `(site_id, impression_id, kind)` にして、**サイトをまたいだ衝突を作れなくする。**
drop index if exists public.events_once_per_impression;
create unique index if not exists events_once_per_impression_per_site
  on public.events (site_id, impression_id, kind)
  where kind in ('impression', 'close');

-- ══════════════════════════════════════════════════════════════════════
-- ③ 配信: 返す中身を明示的に組み立てる + Origin の判定を NULL に対して閉じる
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **`variants.content` を丸ごと返していた**(Codex 1巡目 sol Medium)。
--   `content` は jsonb の自由な入れ物なので、**管理画面(PR3)が内部向けのメモを1つ足した日に、
--   それが他人の LP へ配られる**。⚠ いまの漏洩検査は「fixture に在る値」しか見つけられないので、
--   **検査では気づけない**種類の漏れ。
-- ✅ **表示に要る鍵だけを名指しで取り出す。** 足すときは、ここに書かないと出ない(fail-closed)。
--   ⚠ `imageKey`(型 B = 画像)は **PR4** で足す。いまは出さない。
create or replace function public.adpop_site_config(p_site_key text, p_origin text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_site     public.sites%rowtype;
  v_popup    public.popups%rowtype;
  v_variants jsonb;
  v_triggers jsonb;
begin
  if p_site_key is null or p_site_key !~ '^[0-9a-f]{32}$' then return null; end if;
  if p_origin is null or not public.adpop_is_origin(p_origin) then return null; end if;

  select * into v_site from public.sites where site_key = p_site_key;
  if not found then return null; end if;

  /*
    🔴 許可ドメインが空のサイトには何も返さない(要件書 §6-5「空 = 全許可にしない」)。
    ⚠ この1文は下の一致判定と重なっていて**単独では観測できない**(2026-09-09 の変異検査で確認)。
      **意図の宣言として残している**。「2枚の守りがある」とは書かない。
    🔴 一致判定は **`coalesce(..., false)` で NULL に対して閉じる**(①の理由)。
      `= any` は NULL 要素が在ると NULL を返し、`not NULL` は成立しない = **素通り**していた。
  */
  if coalesce(array_length(v_site.allowed_origins, 1), 0) = 0 then return null; end if;
  if not coalesce(p_origin = any (v_site.allowed_origins), false) then return null; end if;

  select * into v_popup
  from public.popups
  where site_id = v_site.id and status = 'active'
  order by created_at, id
  limit 1;
  if not found then return null; end if;

  select coalesce(
           jsonb_agg(jsonb_build_object('kind', t.kind::text, 'threshold', t.threshold) order by t.kind),
           '[]'::jsonb)
    into v_triggers
  from public.popup_triggers t
  where t.popup_id = v_popup.id and t.enabled;

  /*
    ⚠ 🕐 `chatbot` のバリアントは v1.1 なので配らない。
    ⚠ **重み(weight)はそのまま返すが、割り当ては PR5**。PR2 の埋め込みは**先頭の1つ**を使う。
    🔴 **並びは決定的だが「作った順」ではない** —— `created_at` の既定はトランザクションの
      開始時刻なので、同じ文で作った行は同値になり、実際の並びは第2キーの `id`(乱数)で決まる。
  */
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'key',    v.public_key,
             'kind',   v.kind::text,
             'weight', v.weight,
             -- 🔴 名指しした鍵だけ。**`content` を丸ごと渡さない**
             'content', jsonb_strip_nulls(jsonb_build_object(
               'headline',    v.content -> 'headline',
               'body',        v.content -> 'body',
               'buttonLabel', v.content -> 'buttonLabel'
             )),
             'destinationUrl', v.destination_url
           ) order by v.created_at, v.id),
           '[]'::jsonb)
    into v_variants
  from public.variants v
  where v.popup_id = v_popup.id and v.kind <> 'chatbot';

  if jsonb_array_length(v_variants) = 0 then return null; end if;

  return jsonb_build_object(
    'v', 1,
    'popup', jsonb_build_object(
      'key',                    v_popup.public_key,
      'minDisplayDelaySeconds', v_popup.min_display_delay_seconds,
      'frequency', jsonb_build_object(
        'suppressDays',       v_popup.suppress_days,
        'sessionImpressions', v_popup.session_impressions,
        'postConversionDays', v_popup.post_conversion_days
      ),
      'triggers', v_triggers,
      'variants', v_variants
    )
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- ④ 投入: 断りの理由を統一 + 大きさの上限 + 値の型
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **`reason` が `site` と `origin` を撃ち分けていた**(Codex 1巡目 Astra Medium)。
--   → **サイトキーが実在するかどうかを、呼んだ側が判別できる**(総当たりで実在キーを選り分けられる)。
--   ✅ **`not_allowed` に統一**する。⚠ ルート側だけ統一しても、関数を直接呼べる経路には効かない
--     (③でその経路は塞いだが、**理由を分けない**のは関数の側の性質として持たせる)。
--
-- 🔴 **大きさの上限を関数にも置く**(Codex 1巡目 sol High / Astra Medium)。
--   ルートにしか無いと、関数を直接呼べる経路で迂回できた。
--   ⚠ ルートは**回線を流れるバイト**を数えて途中で打ち切る(そちらが安い)。
--     ここは**正規化した JSON のバイト**を数える。**測っている対象が違う**ので、値も別に持つ。
--
-- 🔴 **値は全部 JSON の文字列であること**(Codex 1巡目 sol Low)。
--   `->>` は数値も真偽値も text にするので、`{"visitorHash": 12345678901234567890123456789012}` が
--   **32桁の16進として通っていた**。⚠ 埋め込みスクリプトは文字列しか送らないので、締めても壊れない。
create or replace function public.adpop_record_event(p_site_key text, p_origin text, p_event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_site       public.sites%rowtype;
  v_popup_id   uuid;
  v_variant_id uuid;
  v_impression uuid;
  v_page_url   text;
  v_visitor    text;
  v_stored     boolean;
  v_bad_keys   text[];
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'event');
  end if;
  -- ⚠ 上限は 4096 バイト(ルート側と同じ値。**数えている対象は違う**ので、両方に書いてある)
  if octet_length(p_event::text) > 4096 then
    return jsonb_build_object('ok', false, 'reason', 'too_large');
  end if;

  select coalesce(array_agg(e.key order by e.key), '{}') into v_bad_keys
  from jsonb_each(p_event) as e
  where jsonb_typeof(e.value) <> 'string';
  if array_length(v_bad_keys, 1) is not null then
    return jsonb_build_object('ok', false, 'reason', 'types');
  end if;

  -- 🔴 サイトキーと Origin の断りは**区別できない1つの理由**にまとめる
  if p_site_key is null or p_site_key !~ '^[0-9a-f]{32}$'
     or p_origin is null or not public.adpop_is_origin(p_origin) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  select * into v_site from public.sites where site_key = p_site_key;
  if not found
     or coalesce(array_length(v_site.allowed_origins, 1), 0) = 0
     or not coalesce(p_origin = any (v_site.allowed_origins), false) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  /*
    🔴 ポップとバリアントは「公開用の識別子 → そのサイト配下」でしか解決しない。
      呼ぶ側が内部 id を渡す余地が無いので、**他人のサイトの行を指す経路が構造的に無い**。
    ⚠ ここから先の理由は**そのサイトの認可を通った後**なので、分けて返してよい
      (「このサイトにそのポップは無い」は、そのサイトの持ち主にしか意味が無い情報)。
  */
  select id into v_popup_id
  from public.popups
  where site_id = v_site.id and public_key = (p_event ->> 'popupKey');
  if v_popup_id is null then return jsonb_build_object('ok', false, 'reason', 'popup'); end if;

  if nullif(p_event ->> 'variantKey', '') is not null then
    select id into v_variant_id
    from public.variants
    where popup_id = v_popup_id and public_key = (p_event ->> 'variantKey');
    if v_variant_id is null then return jsonb_build_object('ok', false, 'reason', 'variant'); end if;
  end if;

  -- 🔴 query と fragment を**削ってから**入れる。削った後でも形が合わなければ**断る**
  v_page_url := nullif(btrim(coalesce(p_event ->> 'pageUrl', '')), '');
  if v_page_url is not null then
    v_page_url := split_part(split_part(v_page_url, '#', 1), '?', 1);
    if length(v_page_url) > 2048
       or v_page_url !~ '^https?://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$' then
      return jsonb_build_object('ok', false, 'reason', 'pageUrl');
    end if;
  end if;

  v_visitor := nullif(p_event ->> 'visitorHash', '');
  if v_visitor is not null and v_visitor !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok', false, 'reason', 'visitorHash');
  end if;

  begin
    v_impression := nullif(p_event ->> 'impressionId', '')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'reason', 'impressionId');
  end;

  -- 🔴 `conversion` はここでは受けない(CV 計測タグは PR6 の別の入口)
  if (p_event ->> 'kind') not in ('fire', 'suppressed', 'impression', 'click', 'close') then
    return jsonb_build_object('ok', false, 'reason', 'kind');
  end if;

  begin
    insert into public.events (
      owner_id, site_id, popup_id, variant_id, kind, trigger_kind,
      impression_id, visitor_hash, device, close_reason, page_url
    )
    values (
      v_site.owner_id, v_site.id, v_popup_id, v_variant_id,
      (p_event ->> 'kind')::public.event_kind,
      nullif(p_event ->> 'triggerKind', '')::public.trigger_kind,
      v_impression, v_visitor,
      (p_event ->> 'device')::public.device_kind,
      nullif(p_event ->> 'closeReason', '')::public.close_reason,
      v_page_url
    )
    -- 🔴 ②で site を含めたキーへ変えた。**サイトをまたいだ衝突を作れない**
    on conflict (site_id, impression_id, kind) where kind in ('impression', 'close') do nothing
    returning true into v_stored;
  exception
    when check_violation or foreign_key_violation or not_null_violation
      or invalid_text_representation or unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'shape');
  end;

  return jsonb_build_object('ok', true, 'stored', coalesce(v_stored, false));
end;
$$;

comment on function public.adpop_site_config(text, text) is
  'サイトキー + Origin → いま有効なポップの設定(jsonb)。合わなければ null(fail-closed)。内部 id と owner_id は返さない。';
comment on function public.adpop_record_event(text, text, jsonb) is
  '計測イベントの投入。サイト / Origin の断りは not_allowed に統一。page_url は origin+path に削ってから入れる。形の正は 0002 の CHECK。';

-- ══════════════════════════════════════════════════════════════════════
-- ⑤ allow-list(宣言)—— 配信の口を anon から service_role へ移す
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠ **service_role 用の allow-list は 0001 に無い**(0001 は anon と authenticated しか知らない)。
--   → ここで「無ければ作る」で初期化し、下で `create or replace` して中身を入れる。
--   🔴 **0001 の ⑥(配り直し)は anon の分しか見ない**ので、
--     **0001 を流し直すと service_role の EXECUTE が剥がれる**。
--     そのときは**関門(e3s)(e4s)が適用を止める**(静かに配信が死ぬのではなく、赤くなる)。
do $$
begin
  if to_regprocedure('public.adpop_service_callable_functions()') is null then
    execute $q$
      create function public.adpop_service_callable_functions()
      returns text[] language sql immutable as $body$ select '{}'::text[] $body$;
    $q$;
  end if;
end $$;

comment on function public.adpop_service_callable_functions() is
  'service_role が EXECUTE を持ってよい public スキーマの関数。サーバー(Next.js のルート)だけが呼ぶ配信の口。';

-- 🔴 **anon の allow-list を空に戻す。** ここが「誰でも直接叩ける」構造をやめた本体。
create or replace function public.adpop_anon_callable_functions()
returns text[] language sql immutable as $$ select '{}'::text[] $$;

create or replace function public.adpop_service_callable_functions()
returns text[] language sql immutable as $$
  select array[
    'public.adpop_site_config(text, text)',
    'public.adpop_record_event(text, text, jsonb)'
  ]::text[];
$$;

revoke all on function public.adpop_service_callable_functions()
  from public, anon, authenticated, service_role;
revoke all on function public.adpop_anon_callable_functions()
  from public, anon, authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════
-- ⑥ 締める(anon から剥がす)
-- ══════════════════════════════════════════════════════════════════════
revoke all on function public.adpop_site_config(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.adpop_record_event(text, text, jsonb)
  from public, anon, authenticated, service_role;
-- ⚠ anon の入口(schema USAGE)も閉じる。**anon から呼べる関数は0本に戻った**
revoke usage on schema public from anon;

-- ══════════════════════════════════════════════════════════════════════
-- ⑦ 関門を v2 へ(**適用済みの DB にも届く形で置き直す**)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **0001 を書き換えただけでは、既に 0001 を適用した DB には1ミリも届かない**
--   (Codex 1巡目 Astra Medium)。マイグレーションは1度しか流れない。
--   → **関門の「いまの正」は、いつも最も新しいマイグレーションが持つ。**
--   ⚠ 0001 側は「無ければ作る」に変えたので、**流し直しても新しい版を古い版へ戻さない**。

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
  allowed_service_oids oid[];
  unresolved        text[];
  offenders   text[];
  probe_tbl   constant text := 'zz_adpop_privilege_probe_tbl';
  probe_seq   constant text := 'zz_adpop_privilege_probe_seq';
  probe_fn    constant text := 'zz_adpop_privilege_probe_fn';
  probe_ns    text;
begin
  -- (0) allow-list の署名を OID に解決する。解決できないものが1つでもあれば落とす。
  select coalesce(array_agg(sig order by sig), '{}') into unresolved
  from unnest(allowed || allowed_auth || allowed_service) as sig
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
  from unnest(allowed || allowed_auth || allowed_service) as sig
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
      -- 🔴 v2: 配信の口は service_role から呼ぶ。**宣言した分だけ**を許す
      and not (ro.g = 'service_role' and p.oid = any (allowed_service_oids))
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

  -- (es) 同じ規則を service_role にも当てる(v2 で配信の口がこちらへ移ったため)
  select coalesce(array_agg(ns order by ns), '{}') into offenders
  from unnest(exposed) as ns
  where has_schema_privilege('service_role', ns, 'USAGE')
    and not exists (
      select 1
      from unnest(allowed_service) as sig
      join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ns
    );
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(es): service_role から呼べる関数が1本も無いのに、service_role が USAGE を持つスキーマがあります: %',
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

  /*
    (e3s)(e4s) 🔴 **配り漏れの向きを service_role でも見る。**
      0001 の ② と ③ は流し直すたびに service_role からも剥がすが、
      0001 の ⑥ は **anon の allow-list ぶんしか配り直さない**(0001 は service_role を知らない)。
      → **0001 を流し直したら、ここが止める。**静かに配信が死ぬのではなく、適用が失敗する。
      ⚠ 直し方は「最新のマイグレーションも流し直す」。例外文にそう書く。
  */
  select coalesce(array_agg(sig order by sig), '{}') into offenders
  from unnest(allowed_service) as sig
  where not has_function_privilege('service_role', to_regprocedure(sig), 'EXECUTE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e3s): allow-list に載っているのに service_role が実行できない関数があります(0001 を流し直したなら、最新のマイグレーションも流し直してください): %',
      array_to_string(offenders, ', ');
  end if;

  select coalesce(array_agg(distinct ns order by ns), '{}') into offenders
  from (
    select n.nspname as ns
    from unnest(allowed_service) as sig
    join pg_catalog.pg_proc p on p.oid = to_regprocedure(sig)::oid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  ) s
  where not has_schema_privilege('service_role', ns, 'USAGE');
  if array_length(offenders, 1) is not null then
    raise exception 'ADPOP 権限の関門(e4s): allow-list の関数が在るスキーマの USAGE を service_role が持っていません(0001 を流し直したなら、最新のマイグレーションも流し直してください): %',
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
      from (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
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
      from (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
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
      from (values ('anon'), ('authenticated'), ('service_role'), ('public')) ro(g)
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
  'ADPOP 権限の関門 v2。書いた SQL ではなく実効の権限を測る。いまの正はこの定義(0004)。';
revoke all on function public.adpop_assert_privilege_rules() from public, anon, authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════
-- ⑧ 開ける(service_role にだけ配る)
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠ **表への grant は1文も無い。** service_role が6つの業務テーブルに権限を持たないことは、
--   関門(a)(a2) と、CI の「実物の PostgREST を叩く」ジョブが毎回測っている。
grant usage on schema public to service_role;
grant execute on function public.adpop_site_config(text, text)   to service_role;
grant execute on function public.adpop_record_event(text, text, jsonb) to service_role;

select public.adpop_assert_privilege_rules();
