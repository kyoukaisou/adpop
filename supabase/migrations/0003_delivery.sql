-- ADPOP 0003: 配信(サイトキー → 設定)とイベント投入を、**anon から呼べる関数2本**として開ける。
--
-- 🔴 **anon には業務テーブルの権限を1つも配らない**(要件書 §5-3)。
--   0001 が「配らない」に倒した状態を維持したまま、**関門(0001 の allow-list)に載せた
--   `security definer` の関数2本だけ**を anon へ開ける。
--   ⚠ 表への grant は1文も足さない。足したら 0001 の関門(a)が落ちる。
--
-- 🔴 **このファイルは再実行できる形で書く。**
--   0002 までは「流す先はローカルだけなので `db reset` でよい」を理由に再実行できない形だったが、
--   **PR2 以降は実データのある DB に流すことになる**(2026-09-08 の申し送り)。
--   → `add column if not exists` / `create or replace` / `create unique index if not exists` /
--     制約は `pg_constraint` を見てから足す、で書く。**再実行できることは検査で固定する。**
--
-- 🔴 **並びの規則(0001・0002 と同じ)**: 締める側を先に、開ける側を後に。
--   ①列 → ②関数(定義するだけ。この時点では誰も呼べない) → ③allow-list の宣言 →
--   ④revoke → ⑤**最後に grant** → ⑥関門。
--   どの文の直後で止まっても、**宣言より広く開くことはない**。

-- ══════════════════════════════════════════════════════════════════════
-- ① 公開用の識別子(popups / variants)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **配信エンドポイントは内部 id を1バイトも返さない**(発注書の指定)。
--   埋め込みスクリプトは「どのポップの、どのバリアントを出したか」をイベントに載せる必要があるので、
--   **返してよい識別子を別に持つ**。形は `sites.site_key` と揃える(32桁の16進 = 122ビットの乱数)。
--   ⚠ **公開値**である(他人の LP の HTML から観測できる)。秘密として扱わない ——
--     守るのは許可ドメイン(§5-3)で、この値の秘匿ではない。
--   ⚠ 内部の uuid をそのまま出さない理由は「秘密だから」ではなく、
--     **外に出した瞬間に、その値の形と寿命が API の約束になる**ため(主キーは差し替えられなくなる)。
--
-- ⚠ `gen_random_uuid()` は volatile なので、**既存の行にも1行ずつ違う値が入る**(表の書き換えが走る)。
--   いま行数は0〜数十なので代償はゼロ。⚠ events のような大きな表に同じ書き方をしない。
alter table public.popups
  add column if not exists public_key text not null default replace(gen_random_uuid()::text, '-', '');
alter table public.variants
  add column if not exists public_key text not null default replace(gen_random_uuid()::text, '-', '');

-- ⚠ 一意制約ではなく**一意索引**にする(`if not exists` がそのまま使えて再実行できる)。
create unique index if not exists popups_public_key_idx   on public.popups   (public_key);
create unique index if not exists variants_public_key_idx on public.variants (public_key);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.popups'::regclass and conname = 'popups_public_key_shape'
  ) then
    alter table public.popups
      add constraint popups_public_key_shape check (public_key ~ '^[0-9a-f]{32}$');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.variants'::regclass and conname = 'variants_public_key_shape'
  ) then
    alter table public.variants
      add constraint variants_public_key_shape check (public_key ~ '^[0-9a-f]{32}$');
  end if;
end $$;

-- 配信は「サイトキー → そのサイトの active なポップ」を毎回引く。索引を置く。
create index if not exists popups_site_status_idx on public.popups (site_id, status);

-- ══════════════════════════════════════════════════════════════════════
-- ② 配信: サイトキー + Origin → いま有効なポップの設定
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **fail-closed**(要件書 §5-3 / §6-5)。次のどれか1つでも欠けたら **null を返す**:
--   ・サイトキーの形が違う / そのサイトが無い
--   ・Origin の形が違う / **許可ドメインが空**(⚠「空 = 全許可」にしない)/ 一致しない
--   ・active なポップが無い / そのポップにバリアントが1つも無い
--   ⚠ **「サイトが無い」と「Origin が違う」を呼び出し側から区別できないようにする**
--     (どちらも null)。区別できると、サイトキーの総当たりで**実在するキーだけ**が分かる。
--
-- 🔴 **返す情報は最小**(発注書の指定)。内部 id・`owner_id`・他サイトの情報・
--   他のポップの情報を**1バイトも返さない**。返すのは公開用の識別子と、表示に要る値だけ。
--
-- ⚠ **同じサイトに active なポップが複数在るときは1つしか返さない**(`created_at, id` の順で最初の1つ)。
--   🔴 **要件書はこの場合を決めていない**(申し送り: PR3 の管理画面で「1サイト1つだけ active」に
--     するのか、複数を許してページごとに出し分けるのかを決める)。
--   いまは**決めていないことを黙って決めない**ために、**決定的な順序で1つ**に倒してある。
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
  -- 形が違う入力は、表を1度も読まずに断る
  if p_site_key is null or p_site_key !~ '^[0-9a-f]{32}$' then return null; end if;
  if p_origin is null or not public.adpop_is_origin(p_origin) then return null; end if;

  select * into v_site from public.sites where site_key = p_site_key;
  if not found then return null; end if;

  /*
    🔴 許可ドメインが空のサイトには何も返さない(要件書 §6-5「空 = 全許可にしない」)。
    ⚠ **この1文は、下の `= any` と重なっていて、単独では観測できない**(2026-09-09 の変異検査で確認)
      —— 空配列に対して `p_origin = any('{}')` は偽なので、消しても振る舞いが1ミリも変わらない。
      **意図の宣言として残している**(次に `= any` を書き換える人が、空配列の扱いを見落とさないため)。
      🔴 したがって **「2枚の守りがある」とは書かない**。守っているのは実質1枚。
  */
  if coalesce(array_length(v_site.allowed_origins, 1), 0) = 0 then return null; end if;
  if not (p_origin = any (v_site.allowed_origins)) then return null; end if;

  select * into v_popup
  from public.popups
  where site_id = v_site.id and status = 'active'
  order by created_at, id
  limit 1;
  if not found then return null; end if;

  /*
    ⚠ **有効なトリガだけを返す**(OFF のものは埋め込み先に配らない = 無駄な情報を出さない)。
    ⚠ **6種すべて**をそのまま返す。埋め込みスクリプトが PR2 で実装しているのは
      `back` と `exit_intent` の2つだけで、**知らない kind は無視する**(README に明記)。
      → PR4 で残りを実装するとき、サーバー側は1文も変えなくてよい。
  */
  select coalesce(
           jsonb_agg(jsonb_build_object('kind', t.kind::text, 'threshold', t.threshold) order by t.kind),
           '[]'::jsonb)
    into v_triggers
  from public.popup_triggers t
  where t.popup_id = v_popup.id and t.enabled;

  /*
    ⚠ 🕐 `chatbot` のバリアントは v1.1(要件書 §3 除外13)なので配らない。
    ⚠ **重み(weight)はそのまま返すが、割り当ては PR5**。PR2 の埋め込みスクリプトは
      **先頭の1つ**を使う(README に明記)。
    🔴 **並びは決定的だが「作った順」ではない**(2026-09-09 実測)。
      `created_at` の既定は `now()` = **トランザクションの開始時刻**なので、
      **同じトランザクションで作った行は同値**になり、実際の並びは第2キーの `id`(乱数)で決まる。
      → 言えるのは「**毎回同じ順で返る**」だけ。PR2 が先頭の1つを使う以上、
        必要なのは決定性のほうなので、いまはこれで足りる。
      ⚠ PR5 で重みによる割り当てを入れるときは、**この並びに依存させない**
        (重みの累積で選ぶ = 並びが変わっても割り当ては変わらない形にする)。
  */
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'key',            v.public_key,
             'kind',           v.kind::text,
             'weight',         v.weight,
             'content',        v.content,
             'destinationUrl', v.destination_url
           ) order by v.created_at, v.id),
           '[]'::jsonb)
    into v_variants
  from public.variants v
  where v.popup_id = v_popup.id and v.kind <> 'chatbot';

  -- バリアントが1つも無いポップは、出しようが無い。**取りに来させない**(fail-closed)
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

comment on function public.adpop_site_config(text, text) is
  'サイトキー + Origin → いま有効なポップの設定(jsonb)。合わなければ null(fail-closed)。内部 id と owner_id は返さない。';

-- ══════════════════════════════════════════════════════════════════════
-- ③ イベント投入
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **`page_url` は origin + path だけを保存する**(要件書 §6 裁定4)。
--   ⚠ **CHECK 制約に当てて落とすのではなく、ここで削ってから入れる**(発注書の指定)。
--     0002 の CHECK は**その検算**で、両方在って初めて「削り忘れた日に気づける」。
--
-- 🔴 **形の正は 0002 の CHECK 制約**(§4-7 を DB に落としたもの)。
--   この関数は**同じ規則を書き写さない** —— 書き写すと、片方だけ直した日に静かにずれる
--   (アプリ層の判定を DB 制約の代わりにしない)。
--   → **正規化だけをここで行い、形の判定は insert に当てて、例外を「断り」に翻訳する。**
--
-- ⚠ **偽造は防げない**(要件書 §4-7 の注記)。ここで防いでいるのは
--   「他人のサイトのイベントを入れる」「階層が実在しない行を入れる」「個人情報を URL に載せる」の3つだけ。
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
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'event');
  end if;
  if p_site_key is null or p_site_key !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok', false, 'reason', 'site');
  end if;
  if p_origin is null or not public.adpop_is_origin(p_origin) then
    return jsonb_build_object('ok', false, 'reason', 'origin');
  end if;

  select * into v_site from public.sites where site_key = p_site_key;
  if not found then return jsonb_build_object('ok', false, 'reason', 'site'); end if;
  if coalesce(array_length(v_site.allowed_origins, 1), 0) = 0
     or not (p_origin = any (v_site.allowed_origins)) then
    return jsonb_build_object('ok', false, 'reason', 'origin');
  end if;

  /*
    🔴 **ポップとバリアントは「公開用の識別子 → そのサイト配下」でしか解決しない。**
      呼ぶ側が内部 id を渡す余地が無いので、**他人のサイトの行を指す経路が構造的に無い**。
      ⚠ 0002 の階層の複合外部キーは、それでも残す(2か所で見る)。
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

  /*
    🔴 **query と fragment を削ってから入れる**(要件書 §6 裁定4)。
      LP の URL には `?email=…` が普通に載る。**削るのはここの仕事**。
    ⚠ 削った後でも形が合わないものは**断る**(黙って null にして通さない) ——
      静かに列を欠かすと、**ダッシュボードで「URL の無い行」が増えた理由を誰も追えない**。
  */
  v_page_url := nullif(btrim(coalesce(p_event ->> 'pageUrl', '')), '');
  if v_page_url is not null then
    v_page_url := split_part(split_part(v_page_url, '#', 1), '?', 1);
    if length(v_page_url) > 2048
       or v_page_url !~ '^https?://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$' then
      return jsonb_build_object('ok', false, 'reason', 'pageUrl');
    end if;
  end if;

  -- 匿名ID。**在るのに形が違うものは断る**(黙って落とすと、頻度制御の効きが静かに変わる)
  v_visitor := nullif(p_event ->> 'visitorHash', '');
  if v_visitor is not null and v_visitor !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok', false, 'reason', 'visitorHash');
  end if;

  begin
    v_impression := nullif(p_event ->> 'impressionId', '')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'reason', 'impressionId');
  end;

  /*
    🔴 **`conversion` はここでは受けない。** CV 計測タグは PR6 で、
      「サンクスページに置いたタグ」= **別の入口**になる(要件書 §4-7)。
      ⚠ ここで受けられるようにしておくと、**誰でも CV を水増しできる口**が
        1つ早く開くことになる(実装より広い口を先に開けない)。
  */
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
    -- 🔴 表示と閉じるは impression_id につき1回(0002 の部分一意索引)。**再送で増やさない。**
    on conflict (impression_id, kind) where kind in ('impression', 'close') do nothing
    returning true into v_stored;
  exception
    /*
      ⚠ ここで捕まえるのは **0002 の CHECK / FK / enum の変換**だけ。
        規則そのものは DB が持ったままで、この関数は**断りに翻訳するだけ**。
      ⚠ `others` で捕まえない —— 捕まえると、**書けなかった理由が全部 400 に見える**
        (接続の問題も、こちらのバグも)。
    */
    when check_violation or foreign_key_violation or not_null_violation
      or invalid_text_representation or unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'shape');
  end;

  -- `stored=false` = 重複排除で落ちた(**断りではない**)
  return jsonb_build_object('ok', true, 'stored', coalesce(v_stored, false));
end;
$$;

comment on function public.adpop_record_event(text, text, jsonb) is
  '計測イベントの投入。サイトキー + Origin で fail-closed、page_url は origin+path に削ってから入れる。形の正は 0002 の CHECK。';

-- ══════════════════════════════════════════════════════════════════════
-- ④ allow-list の宣言(**配る側と同じファイルに置く**)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 0001 の関門(c)は「anon が EXECUTE を持ってよいのは、ここに宣言した分だけ」を見る。
--   関門(e3)(e4)は逆向きに「**宣言した分がいま実際に配られているか**」を見る。
--   ⚠ 宣言と grant を別のファイルに分けると、片方だけ流れた瞬間に**関門が適用を止める**。
create or replace function public.adpop_anon_callable_functions()
returns text[]
language sql
immutable
as $$
  select array[
    'public.adpop_site_config(text, text)',
    'public.adpop_record_event(text, text, jsonb)'
  ]::text[];
$$;

-- ══════════════════════════════════════════════════════════════════════
-- ⑤ 権限(締める → 開ける)
-- ══════════════════════════════════════════════════════════════════════
revoke all on function public.adpop_anon_callable_functions()
  from public, anon, authenticated, service_role;
revoke all on function public.adpop_site_config(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.adpop_record_event(text, text, jsonb)
  from public, anon, authenticated, service_role;

-- 🔴 **anon へ開けるのはこの3文だけ。表への grant は1文も無い。**
--   ⚠ schema の USAGE は「関数に届くための入口」で、**それ単体では1つの表にも触れない**
--     (表の権限は 0002 が authenticated にしか配っていない = 関門(a)が毎回測る)。
grant usage on schema public to anon;
grant execute on function public.adpop_site_config(text, text)   to anon;
grant execute on function public.adpop_record_event(text, text, jsonb) to anon;

select public.adpop_assert_privilege_rules();
