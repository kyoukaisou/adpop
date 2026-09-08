-- ADPOP 0002: データモデル(要件書 §6 が正)+ RLS + 権限。
--
-- 前提(要件書 §6):
--   ・v1 は単一管理者だが、**複数サイト・複数ポップを扱える構造**にする
--   ・将来のマルチテナント化のため **`owner_id` を最初から全表に持つ**
--   ・チャットボット型(`variants.kind = 'chatbot'` と `chatbot_nodes`)は **表だけ作る**。実装は v1.1
--
-- 🔴 **並びの規則**: 締める側を先に、開ける側を後に。
--   このファイルは ①型 → ②表(RLS を有効にしてから) → ③ポリシー → ④**最後に grant**、の順で書く。
--   どの文の直後で止まっても、**grant が付いた表には既にポリシーが在る**。
--   逆順(先に grant)だと、途中で止まったとき「権限は在るがポリシーが無い」= 全拒否ではあるが、
--   **ポリシーの無い表に権限が付いた状態**が残る。並びで安全側に倒す。
--
-- ⚠ **このファイルは再実行できない**(`create type` / `create table` / `create policy` は
--   途中まで流れた DB に流し直すと「既に在る」で落ちる)。**0001 は再実行できる**が、こちらは違う。
--   🔴 いま**その代償はゼロ**である —— クラウドのプロジェクトはまだ1つも無く、
--     流す先はローカルだけなので、失敗したら `supabase db reset` でよい。
--   🔴 **PR2 以降のマイグレーションは、実データのある DB に流すことになるので再実行できる形で書く**
--     (`create or replace` / `if not exists` / `drop … if exists` を使う)。ここが分かれ目。
--
-- 🔴 **他人のサイトにポップをぶら下げられない**ようにするのは、`owner_id` の一致を
--   **複合外部キー**で DB に強制する形にした(アプリ側の検算に頼らない)。
--     popups(site_id, owner_id) → sites(id, owner_id)
--   ⚠ これが無いと、RLS を通した自分の owner_id を持ちながら、他人の site_id を指す行を作れる。

-- ══════════════════════════════════════════════════════════════════════
-- ① 列挙型
-- ══════════════════════════════════════════════════════════════════════
create type public.popup_status as enum ('draft', 'active', 'paused');

-- 要件書 §4-2 の6トリガ。①戻る ②スクロール ③無操作 ④滞在 ⑤タブ切替 ⑥exit intent
create type public.trigger_kind as enum ('back', 'scroll', 'idle', 'dwell', 'visibility', 'exit_intent');

-- 🕐 'chatbot' は v1.1(要件書 §3 除外13)。**値は最初から置く**(後から enum に足すのは可能だが、
--    データモデルを「最初から入れておく」が本部裁定なので、値も表も今のうちに置く)。
create type public.variant_kind as enum ('text', 'image', 'chatbot');

create type public.event_kind as enum ('fire', 'suppressed', 'impression', 'click', 'close', 'conversion');
create type public.close_reason as enum ('button', 'backdrop', 'esc');

-- 🔴 端末は2値だけ(要件書 §5-4)。**生の User-Agent は保存しない。**
create type public.device_kind as enum ('mobile', 'desktop');

-- ══════════════════════════════════════════════════════════════════════
-- ② 補助関数(CHECK から呼ぶ。immutable)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **遷移先 URL は https のみ**(要件書 §5-3)。`javascript:` / `data:` を弾く。
--   ⚠ 要件書は「**保存時と描画時の両方で検査する**」と書いている。ここは**保存時**の側。
--     描画時(埋め込みスクリプト)の検査は PR2。**片方だけだと、DB を直接触られた時に素通りする**。
--   ⚠ 大文字の `HTTPS://` は弾く(fail-closed。正規化はアプリの仕事で、DB は判定だけする)。
--   ⚠ **長さは正規表現で書けない**(2026-09-08 実測): PostgreSQL の正規表現は
--     繰り返し回数の上限が 255 で、`{1,2040}` は `invalid repetition count(s)` になる。
--     → **長さは `length()` で、形は正規表現で**、と分けて書く。
create function public.adpop_is_https_url(url text)
returns boolean
language sql
immutable
as $$
  select length(url) <= 2048 and url ~ '^https://[^[:space:]<>"'']+$'
$$;

-- 許可ドメイン(要件書 §5-3 の allowlist)。**Origin の形だけを見る**(スキーム + ホスト + 任意のポート)。
-- ⚠ パス・末尾スラッシュ・ワイルドカードを受け付けない。`Origin` ヘッダと**そのまま比較できる形**に限る。
-- ⚠ 空配列は許す。**「空 = 全許可」にはしない**のは配信側の責任(要件書 §6-5。fail-closed は PR2)。
create function public.adpop_is_origin(origin text)
returns boolean
language sql
immutable
as $$
  select origin ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$'
$$;

create function public.adpop_is_origin_list(origins text[])
returns boolean
language sql
immutable
as $$
  select coalesce(bool_and(public.adpop_is_origin(o)), true) from unnest(origins) as o
$$;

-- ══════════════════════════════════════════════════════════════════════
-- ③ 表
-- ══════════════════════════════════════════════════════════════════════

-- ── サイト ─────────────────────────────────────────────────────────
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  /*
    🔴 **サイトキーは推測不能な乱数**(要件書 §6-6。連番・UUIDv1 を使わない)。
      `gen_random_uuid()` は v4(乱数)。ハイフンを落として32桁の16進にする = 122 ビットの乱数。
    ⚠ **公開値**である(HTML に出る)。秘密として扱わない —— 守るのは許可ドメイン(§5-3)。
  */
  site_key    text not null unique default replace(gen_random_uuid()::text, '-', '')
                check (site_key ~ '^[0-9a-f]{32}$'),
  allowed_origins text[] not null default '{}'
                check (public.adpop_is_origin_list(allowed_origins)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 子表から複合外部キーで参照するために要る(所有者の一致を DB に強制する)
  unique (id, owner_id)
);

-- ── ポップ ─────────────────────────────────────────────────────────
create table public.popups (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid not null references auth.users (id) on delete cascade,
  site_id   uuid not null,
  name      text not null check (length(btrim(name)) > 0),
  status    public.popup_status not null default 'draft',
  -- 要件書 §4-4 の頻度制御(既定値も §4-4 のとおり)
  suppress_days             smallint not null default 7  check (suppress_days >= 0),
  session_impressions       smallint not null default 1  check (session_impressions >= 1),
  post_conversion_days      smallint not null default 30 check (post_conversion_days >= 0),
  -- 要件書 §4-2 の「最短表示待ち」(既定3秒)
  min_display_delay_seconds smallint not null default 3  check (min_display_delay_seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (site_id, owner_id) references public.sites (id, owner_id) on delete cascade
);
/*
  ⚠ **上限値(何日まで・何回まで)は要件書に無いので置いていない。** 下限だけを縛った。
    上限を DB に書くなら、管理画面(PR3)で入力欄を作るときに値ごと決める。
    ⚠ ここで勝手に決めると、**要件書に無い数字が DB に固定される**(後から緩めるほうが高い)。
*/

-- ── トリガ設定(**行持ち**。要件書 §6 の申し送り1)────────────────────
/*
  🔴 jsonb ではなく行で持つ理由(要件書 §6-1):
    管理画面の ON/OFF・閾値がそのまま行になり、**トリガ別集計(events.trigger_kind)と
    機械で突き合わせられる**。jsonb だと「設定されているトリガ」と「イベントに現れるトリガ」の
    対応を検算できない。
  🔴 **行は ④ の定義トリガが作る。利用者は作れない・消せない**(insert / delete を配らない)。
    → 「6行そろっていないポップ」が存在しえない。
*/
create table public.popup_triggers (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid not null references auth.users (id) on delete cascade,
  popup_id  uuid not null,
  kind      public.trigger_kind not null,
  enabled   boolean not null default false,
  -- 閾値。kind により意味が変わる(スクロール率 % / 無操作の秒 / 滞在の秒)。null 可
  threshold integer null check (threshold is null or threshold >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (popup_id, kind),
  foreign key (popup_id, owner_id) references public.popups (id, owner_id) on delete cascade
);

-- ── バリアント(A/B)─────────────────────────────────────────────
create table public.variants (
  id       uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  popup_id uuid not null,
  kind     public.variant_kind not null default 'text',
  -- 配分(%)。⚠ **合計が 100 になることは DB では担保しない**(要件書 §6-3。下の申し送り参照)
  weight   smallint not null default 100 check (weight between 0 and 100),
  -- 見出し・本文・ボタン文言・画像キー。⚠ 任意 HTML は受け付けない(§3 除外5)= 構造化フィールドのみ
  content  jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  destination_url text not null check (public.adpop_is_https_url(destination_url)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (popup_id, owner_id) references public.popups (id, owner_id) on delete cascade
);
/*
  🔴 **`weight` の合計 100 を DB で担保しない**のは要件書 §6-3 の指定。
    行ごとの制約では書けず、**編集の途中で必ず合計が 100 でない瞬間を通る**(2つ目を足す前など)。
    → **保存時にサーバー側で検算して弾く**(PR5)。⚠ 画面だけに置くと API を直接叩けば通る。
  ⚠ したがって **PR5 まで「合計 100」は誰も守っていない**。
    ここに書いておくのは、次に読む人が「DB が見ている」と誤解しないため。
*/

-- ── チャットボットのノード(🕐 v1.1。表だけ作る)────────────────────
/*
  🕐 要件書 §3 除外13 / §4-3 の C。**v1 では1行も書き込まない。**
    → **書き込み権限を1つも配らない**(⑤ の grant は select だけ)。
    v1.1 で insert/update/delete の grant とポリシーを足す。
  ⚠ 深さ上限5階層・ノード数上限30(§4-3)は **仮置きの値**なので、DB には書いていない。
    上限を掛けるのは v1.1 の実装と同時(仮置きの数字を DB に固定しない)。
*/
create table public.chatbot_nodes (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  variant_id uuid not null,
  parent_node_id uuid null,
  depth      smallint not null default 0 check (depth >= 0),
  prompt     text not null check (length(btrim(prompt)) > 0),
  -- 選択肢。⚠ **自由入力欄を持たない**(§4-3 の C の制約)
  choices    jsonb not null default '[]'::jsonb check (jsonb_typeof(choices) = 'array'),
  -- 終端ノードだけが遷移先を持つ
  destination_url text null check (destination_url is null or public.adpop_is_https_url(destination_url)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (variant_id, owner_id) references public.variants (id, owner_id) on delete cascade,
  foreign key (parent_node_id, owner_id) references public.chatbot_nodes (id, owner_id) on delete cascade
);

-- ── 計測イベント ───────────────────────────────────────────────
/*
  要件書 §4-7 が「何をもって1と数えるか」の正。ここはその形を DB に写したもの。
  🔴 **投入は PR2 の関数経由**。この表には **anon にも authenticated にも書き込みを配らない**
    (要件書 §5-3「anon に業務テーブルの権限を1つも配らない」/ 投入はサーバー側の関数)。
  🔴 **行数がいちばん増える表**(§10-D の試算 = 月10万訪問で 90日 約125MB)。
    保持期間を **`kind` ごとに変えられる**必要がある(削るのは `fire` / `suppressed` から)ので、
    `(kind, occurred_at)` の索引を最初から置く。削除処理そのものは PR5。
*/
create table public.events (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  site_id    uuid not null,
  popup_id   uuid null,
  variant_id uuid null,
  kind       public.event_kind not null,
  -- 表示のトリガ種別。⚠ 同時発火は最初の1つだけを記録する(§4-2)
  trigger_kind public.trigger_kind null,
  -- 1回の表示につき1つ発行。click / close / conversion はこれで表示に紐づく(§4-7)
  impression_id uuid null,
  -- 匿名ID(埋め込み先の localStorage 由来)。⚠ 氏名・メール・IP は存在しない(§5-4)
  visitor_hash text null check (visitor_hash is null or visitor_hash ~ '^[0-9a-f]{32}$'),
  device     public.device_kind not null,
  close_reason public.close_reason null,
  page_url   text null check (page_url is null or length(page_url) <= 2048),
  occurred_at timestamptz not null default now(),

  /*
    ⚠ **ポップやバリアントを消すと、その数字も消える**(`on delete cascade`)。
      🔴 これは判断であって、要件書に書いてある指定ではない。
      ・cascade にした理由: 消えた対象の行が `popup_id` だけ null で残ると、
        **ダッシュボードの分母が「どのポップのものか分からない行」で歪む**
      ・代償: **A/B の履歴は、そのバリアントを消した時点で失われる**
      → 履歴を残したいなら「消す」ではなく `status = 'paused'` を使う設計にする(PR3 で画面に効かせる)。
      ⚠ この判断を変えるなら PR5(数値ダッシュボード)より前に決める。後からでは行が戻らない。
  */
  foreign key (site_id, owner_id)    references public.sites (id, owner_id) on delete cascade,
  foreign key (popup_id, owner_id)   references public.popups (id, owner_id) on delete cascade,
  foreign key (variant_id, owner_id) references public.variants (id, owner_id) on delete cascade,

  /*
    🔴 **`kind` ごとに、埋まっていなければならない列が違う**(§4-7)。
      ここを CHECK に落としておかないと、**トリガ別内訳が黙って歪む**
      (trigger_kind が null の impression が混ざっても、誰も落ちない)。
  */
  constraint events_trigger_kind_shape check (
    case kind
      when 'impression' then trigger_kind is not null
      when 'fire'       then true            -- 発火は種別が入るのが普通だが、必須にはしない
      when 'suppressed' then true
      else trigger_kind is null              -- click / close / conversion は表示側が持つ
    end
  ),
  constraint events_impression_id_shape check (
    case kind
      when 'impression' then impression_id is not null
      when 'click'      then impression_id is not null
      when 'close'      then impression_id is not null
      -- 🔴 **紐づく表示が無い CV も記録する**(§4-7。これが無いと分母が歪む)
      when 'conversion' then true
      else impression_id is null             -- fire / suppressed はまだ表示していない
    end
  ),
  constraint events_close_reason_shape check (
    (kind = 'close') = (close_reason is not null)
  ),
  constraint events_popup_shape check (
    case kind when 'conversion' then true else popup_id is not null end
  ),
  constraint events_variant_shape check (
    case kind
      when 'impression' then variant_id is not null
      when 'click'      then variant_id is not null
      when 'close'      then variant_id is not null
      else true
    end
  )
);

/*
  🔴 **重複排除は DB 側で効かせる**(要件書 §6 の申し送り2。アプリ層の判定を制約の代わりにしない)。
    ・**表示と閉じるは `impression_id` につき1回**。再送・戻る操作で二重に増えない
    ・**クリックは複数回ありうる**(§4-7。CTR はダッシュボード側でユニークに畳む)
    ・**CV も複数ありうる**(同じ表示のあとに2回買う人を落とさない)
*/
create unique index events_once_per_impression
  on public.events (impression_id, kind)
  where kind in ('impression', 'close');

create index events_owner_occurred_at on public.events (owner_id, occurred_at desc);
create index events_popup_kind_occurred_at on public.events (popup_id, kind, occurred_at);
create index events_kind_occurred_at on public.events (kind, occurred_at);
create index events_impression_lookup on public.events (impression_id) where impression_id is not null;

-- ══════════════════════════════════════════════════════════════════════
-- ④ トリガ(updated_at / トリガ設定6行の作成)
-- ══════════════════════════════════════════════════════════════════════
create function public.adpop_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger sites_set_updated_at before update on public.sites
  for each row execute function public.adpop_set_updated_at();
create trigger popups_set_updated_at before update on public.popups
  for each row execute function public.adpop_set_updated_at();
create trigger popup_triggers_set_updated_at before update on public.popup_triggers
  for each row execute function public.adpop_set_updated_at();
create trigger variants_set_updated_at before update on public.variants
  for each row execute function public.adpop_set_updated_at();
create trigger chatbot_nodes_set_updated_at before update on public.chatbot_nodes
  for each row execute function public.adpop_set_updated_at();

/*
  🔴 **ポップを作ったら、6トリガの行が必ず揃う。**
    要件書 §4-2 の既定値(既定 ON = ①戻る・⑥exit intent / 既定値 = スクロール50% / 無操作30秒 / 滞在45秒)を
    ここで1か所に持つ。⚠ **画面側にも既定値を書き写さない**(写しを作ると片方だけ古くなる)。
  ⚠ `security definer` にしているのは、**利用者に popup_triggers の insert を配らないため**。
    配ると「6行そろっていないポップ」や「他人のポップに紐づく行」を作れる余地が生まれる。
    owner_id は **利用者が渡した値ではなく `new.owner_id`**(= RLS が既に auth.uid() と一致を確かめた値)を使う。
*/
create function public.adpop_seed_popup_triggers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.popup_triggers (owner_id, popup_id, kind, enabled, threshold)
  values
    (new.owner_id, new.id, 'back',        true,  null),
    (new.owner_id, new.id, 'scroll',      false, 50),
    (new.owner_id, new.id, 'idle',        false, 30),
    (new.owner_id, new.id, 'dwell',       false, 45),
    (new.owner_id, new.id, 'visibility',  false, null),
    (new.owner_id, new.id, 'exit_intent', true,  null);
  return null;
end;
$$;

create trigger popups_seed_triggers after insert on public.popups
  for each row execute function public.adpop_seed_popup_triggers();

-- ══════════════════════════════════════════════════════════════════════
-- ⑤ RLS(先に有効化 → ポリシー → 最後に grant)
-- ══════════════════════════════════════════════════════════════════════
alter table public.sites          enable row level security;
alter table public.popups         enable row level security;
alter table public.popup_triggers enable row level security;
alter table public.variants       enable row level security;
alter table public.chatbot_nodes  enable row level security;
alter table public.events         enable row level security;

/*
  🔴 **ポリシーは「配る権限」と同じ形だけ書く。**
    書き込みを配らない表(chatbot_nodes / events)には **insert / update / delete のポリシーを作らない**。
    → **将来だれかが grant を1文足しても、ポリシーが無いので通らない**(迂回には権限とポリシーの
      2つが要る = [[SaaS開発ナレッジ]] 2026-09-07-50 の実測)。
  ⚠ `(select auth.uid())` と括るのは Supabase の作法(行ごとに評価されず初期計画で1回になる)。
*/
create policy sites_select on public.sites for select to authenticated
  using (owner_id = (select auth.uid()));
create policy sites_insert on public.sites for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy sites_update on public.sites for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy sites_delete on public.sites for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy popups_select on public.popups for select to authenticated
  using (owner_id = (select auth.uid()));
create policy popups_insert on public.popups for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy popups_update on public.popups for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy popups_delete on public.popups for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ⚠ 行を作る・消すのは定義トリガと popups の削除だけ。ここは select / update のみ。
create policy popup_triggers_select on public.popup_triggers for select to authenticated
  using (owner_id = (select auth.uid()));
create policy popup_triggers_update on public.popup_triggers for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy variants_select on public.variants for select to authenticated
  using (owner_id = (select auth.uid()));
create policy variants_insert on public.variants for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy variants_update on public.variants for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy variants_delete on public.variants for delete to authenticated
  using (owner_id = (select auth.uid()));

-- 🕐 v1 は読むだけ(v1.1 で書き込みのポリシーと grant を足す)
create policy chatbot_nodes_select on public.chatbot_nodes for select to authenticated
  using (owner_id = (select auth.uid()));

-- 投入は PR2 の関数経由。ここは読むだけ。
create policy events_select on public.events for select to authenticated
  using (owner_id = (select auth.uid()));

-- ══════════════════════════════════════════════════════════════════════
-- ⑥ 権限(0001 で既定privilege を止めてあるので、ここに書いた分だけが実効になる)
-- ══════════════════════════════════════════════════════════════════════
--
-- 🔴 **anon には1つも配らない。** 配信用にサイトキー→設定を返す口は **PR2 で関数1本**にする
--   (要件書 §5-3。表を直接読ませない)。
grant select, insert, update, delete on public.sites    to authenticated;
grant select, insert, update, delete on public.popups   to authenticated;
grant select, insert, update, delete on public.variants to authenticated;
grant select, update                 on public.popup_triggers to authenticated;
grant select                         on public.chatbot_nodes  to authenticated;
grant select                         on public.events         to authenticated;

/*
  🔴 **CHECK 制約の中の関数呼び出しは、実行するロールの EXECUTE 権限を見る**(2026-09-08 実測)。
    最初この3本を authenticated からも取り上げたら、**行の insert が `42501
    permission denied for function adpop_is_origin_list` で落ちた**。
    ⚠ トリガ関数は違う —— **発火に EXECUTE は要らない**(権限を見るのは `create trigger` の時点だけ)。
      だから `adpop_set_updated_at` / `adpop_seed_popup_triggers` は誰にも配らない。
  ✅ 配る範囲は **authenticated だけ**。3本とも **immutable な述語で、表を1つも読まない**
    (引数の文字列が https の形か・Origin の形か、を返すだけ)。
    ⚠ anon / service_role / PUBLIC には配らない = 0001 の関門(c)が毎回それを測る。
*/
revoke all on function public.adpop_is_https_url(text)     from public, anon, service_role;
revoke all on function public.adpop_is_origin(text)        from public, anon, service_role;
revoke all on function public.adpop_is_origin_list(text[]) from public, anon, service_role;
grant execute on function public.adpop_is_https_url(text)     to authenticated;
grant execute on function public.adpop_is_origin(text)        to authenticated;
grant execute on function public.adpop_is_origin_list(text[]) to authenticated;
revoke all on function public.adpop_set_updated_at()     from public, anon, authenticated, service_role;
-- 🔴 `security definer` の関数はとくに配らない(トリガから走るだけ。直接呼ばせない)。
--   ⚠ トリガの発火に EXECUTE 権限は要らない(権限を見るのは `create trigger` の時点だけ)。
revoke all on function public.adpop_seed_popup_triggers() from public, anon, authenticated, service_role;

select public.adpop_assert_privilege_rules();
