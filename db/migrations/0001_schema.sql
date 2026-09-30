-- ADPOP 0001(D1 / SQLite): データモデル。要件書 §6 が正。
--
-- 2026-09-30 に土台を Supabase(PostgreSQL)から Cloudflare D1 へ移した(D-295)。
-- PostgreSQL 版(旧 supabase/migrations/0001〜0006)にあった守りのうち、
-- **D1 に置けるものはここに置き、置けないものはアプリ(src/lib/data/)に移した**。
-- 移せなかったもの・弱くなったものは README の「D1 に移して弱くなった守り」に書いてある。
--
-- 🔴 **D1 には RLS もロールも GRANT も無い。** 誰がどの行に触れるかは、DB ではなく
--   **`src/lib/data/` の関数が、読み取り・更新・削除の条件に所有者(owner_id)を入れる**ことで守る
--   (tests/d1-owner-isolation.test.ts が公開関数を全部撃つ)。
-- 🔴 **D1 には、旧版の PostgREST に当たる匿名で叩ける API が無い**(Cloudflare の製品の性質。測ってはいない)。
--   届く経路は、この D1 をバインドした Worker と、Cloudflare アカウントの側(ダッシュボード・API トークン・wrangler)。
--
-- ⚠ SQLite には正規表現が無い。形の検査は GLOB / LIKE で書ける範囲だけをここに置き、
--   **完全な判定は `src/lib/data/shapes.ts`**(配信と管理画面が同じ関数を使う)。
-- ⚠ 時刻は ISO 8601 の文字列(UTC・ミリ秒つき)で持つ。

-- ══════════════════════════════════════════════════════════════════════
-- 所有者
-- ══════════════════════════════════════════════════════════════════════
-- v1 は管理者1人。**将来のマルチテナント化のため owner_id を全表に持つ**(要件書 §6 の前提)。
-- ⚠ 認証の資格(パスワードのハッシュ・セッション)は PR3b でこの表に紐づける。
create table owners (
  id         text primary key check (length(id) = 36),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ══════════════════════════════════════════════════════════════════════
-- サイト
-- ══════════════════════════════════════════════════════════════════════
create table sites (
  id         text primary key check (length(id) = 36),
  owner_id   text not null references owners (id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  -- 🔴 推測不能な乱数(32桁の16進)。**公開値**(HTML に出る)。守るのは許可ドメイン
  site_key   text not null unique
               check (length(site_key) = 32 and site_key not glob '*[^0-9a-f]*'),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (id, owner_id)
);

-- 🔴 許可ドメインは**行で持つ**(配列にしない)。
--   ・「空 = 全許可」にしない が、**行が無ければ一致しない**という形で構造から効く
--   ・1行ずつ CHECK が掛かる
create table site_allowed_origins (
  site_id  text not null,
  owner_id text not null,
  -- ⚠ ここは「https:// で始まり、パス・クエリ・空白・大文字を含まない」まで。
  --   ホスト名の形の完全な判定は shapes.ts の isOrigin(配信は入口でそれを通す)。
  origin   text not null check (
    length(origin) between 12 and 300
    and origin glob 'https://*'
    and substr(origin, 9) not glob '*[^a-z0-9.:-]*'
    and substr(origin, 9) not glob '.*'
  ),
  primary key (site_id, origin),
  foreign key (site_id, owner_id) references sites (id, owner_id) on delete cascade
);

-- ══════════════════════════════════════════════════════════════════════
-- ポップ
-- ══════════════════════════════════════════════════════════════════════
create table popups (
  id         text primary key check (length(id) = 36),
  owner_id   text not null,
  site_id    text not null,
  public_key text not null unique
               check (length(public_key) = 32 and public_key not glob '*[^0-9a-f]*'),
  name       text not null check (length(trim(name)) > 0),
  status     text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  -- 要件書 §4-4 / §4-2。⚠ 上限値は要件書に無いので、旧版の smallint の上限(32767)だけ写した
  suppress_days             integer not null default 7  check (suppress_days between 0 and 32767),
  session_impressions       integer not null default 1  check (session_impressions between 1 and 32767),
  post_conversion_days      integer not null default 30 check (post_conversion_days between 0 and 32767),
  min_display_delay_seconds integer not null default 3  check (min_display_delay_seconds between 0 and 32767),
  -- 🔴 削除ではなくアーカイブを既定の操作にする(要件書 §6 裁定1)。**アーカイブしたら稼働にできない**
  archived_at text null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  check (archived_at is null or status <> 'active'),
  unique (id, owner_id),
  unique (id, site_id),
  foreign key (site_id, owner_id) references sites (id, owner_id) on delete cascade
);

-- 🔴 **稼働中(active)は1サイトに1つ**(D-020)。2つ目は一意制約で落ちる
create unique index popups_one_active_per_site on popups (site_id) where status = 'active';
create index popups_site on popups (site_id);

-- ══════════════════════════════════════════════════════════════════════
-- トリガ設定(6行。ポップを作ると下のトリガが揃える)
-- ══════════════════════════════════════════════════════════════════════
create table popup_triggers (
  owner_id  text not null,
  popup_id  text not null,
  kind      text not null
              check (kind in ('back', 'scroll', 'idle', 'dwell', 'visibility', 'exit_intent')),
  enabled   integer not null default 0 check (enabled in (0, 1)),
  threshold integer null check (threshold is null or threshold >= 0),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (popup_id, kind),
  foreign key (popup_id, owner_id) references popups (id, owner_id) on delete cascade
);

-- ══════════════════════════════════════════════════════════════════════
-- バリアント(画面上の呼び名は「パターン」)
-- ══════════════════════════════════════════════════════════════════════
create table variants (
  id         text primary key check (length(id) = 36),
  owner_id   text not null,
  popup_id   text not null,
  public_key text not null unique
               check (length(public_key) = 32 and public_key not glob '*[^0-9a-f]*'),
  -- 🕐 'chatbot' は v1.1(要件書 §3 除外13)。値だけ置く
  kind       text not null default 'text' check (kind in ('text', 'image', 'chatbot')),
  weight     integer not null default 100 check (weight between 0 and 100),
  content    text not null default '{}'
               check (json_valid(content) and json_type(content) = 'object'),
  -- 🔴 https のみ。空白・引用符・山括弧を含まない(埋め込みの isSafeDestination と同じ規則の、書ける範囲)
  destination_url text not null check (
    length(destination_url) between 9 and 2048
    and destination_url glob 'https://?*'
    and destination_url not glob ('*[' || char(9, 10, 11, 12, 13, 32, 34, 39, 60, 62) || ']*')
  ),
  archived_at text null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (id, owner_id),
  unique (id, popup_id),
  foreign key (popup_id, owner_id) references popups (id, owner_id) on delete cascade
);
create index variants_popup on variants (popup_id);

-- 🕐 v1.1。v1 では1行も書き込まない(データ層に書き込む関数を置かない)
create table chatbot_nodes (
  id             text primary key check (length(id) = 36),
  owner_id       text not null,
  variant_id     text not null,
  parent_node_id text null,
  depth          integer not null default 0 check (depth >= 0),
  prompt         text not null check (length(trim(prompt)) > 0),
  choices        text not null default '[]' check (json_valid(choices) and json_type(choices) = 'array'),
  destination_url text null check (destination_url is null or destination_url glob 'https://?*'),
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (id, owner_id),
  unique (id, variant_id),
  foreign key (variant_id, owner_id) references variants (id, owner_id) on delete cascade,
  foreign key (parent_node_id, variant_id) references chatbot_nodes (id, variant_id) on delete cascade
);

-- ══════════════════════════════════════════════════════════════════════
-- 計測イベント(要件書 §4-7 が「何をもって1と数えるか」の正)
-- ══════════════════════════════════════════════════════════════════════
create table events (
  id            integer primary key,
  owner_id      text not null,
  site_id       text not null,
  popup_id      text null,
  variant_id    text null,
  kind          text not null
                  check (kind in ('fire', 'suppressed', 'impression', 'click', 'close', 'conversion')),
  trigger_kind  text null
                  check (trigger_kind is null
                         or trigger_kind in ('back', 'scroll', 'idle', 'dwell', 'visibility', 'exit_intent')),
  impression_id text null check (impression_id is null or length(impression_id) = 36),
  -- 匿名ID(埋め込み先の localStorage 由来)。32桁の16進だけ(氏名やメールの形は入らない)
  visitor_hash  text null
                  check (visitor_hash is null
                         or (length(visitor_hash) = 32 and visitor_hash not glob '*[^0-9a-f]*')),
  -- 🔴 端末は2値だけ(要件書 §5-4。生の User-Agent は保存しない)
  device        text not null check (device in ('mobile', 'desktop')),
  close_reason  text null check (close_reason is null or close_reason in ('button', 'backdrop', 'esc')),
  -- 🔴 origin + path だけ(要件書 §6 裁定4)。query / fragment / 空白を含まず、
  --   **ホスト部分に `@` を含まない**(`https://taro@example.com/` にメールを入れさせない)。
  --   ⚠ 削るのは投入の関数(src/lib/data/delivery.ts)。ここはその検算。
  page_url      text null check (
    page_url is null or (
      length(page_url) <= 2048
      and (page_url glob 'https://?*' or page_url glob 'http://?*')
      and page_url not glob ('*[?#' || char(9, 10, 11, 12, 13, 32) || ']*')
      and instr(
            substr(substr(page_url, instr(page_url, '://') + 3), 1,
                   case when instr(substr(page_url, instr(page_url, '://') + 3), '/') > 0
                        then instr(substr(page_url, instr(page_url, '://') + 3), '/') - 1
                        else 2048 end),
            '@') = 0
    )
  ),
  occurred_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key (site_id, owner_id)    references sites (id, owner_id) on delete cascade,
  -- 🔴 階層の一致(サイト → ポップ → バリアント)を外部キーで縛る
  foreign key (popup_id, site_id)    references popups (id, site_id) on delete cascade,
  foreign key (variant_id, popup_id) references variants (id, popup_id) on delete cascade,
  check (variant_id is null or popup_id is not null),
  check (case kind when 'impression' then trigger_kind is not null
                   when 'fire' then 1 when 'suppressed' then 1
                   else trigger_kind is null end),
  check (case kind when 'impression' then impression_id is not null
                   when 'click' then impression_id is not null
                   when 'close' then impression_id is not null
                   when 'conversion' then 1
                   else impression_id is null end),
  check ((kind = 'close') = (close_reason is not null)),
  check (case kind when 'conversion' then 1 else popup_id is not null end),
  check (case when kind in ('impression', 'click', 'close') then variant_id is not null else 1 end)
);

-- 🔴 重複排除は DB で効かせる。表示と閉じるは「サイト × impression_id」につき1回
create unique index events_once_per_impression_per_site
  on events (site_id, impression_id, kind) where kind in ('impression', 'close');
create index events_owner_occurred_at on events (owner_id, occurred_at);
create index events_popup_kind_occurred_at on events (popup_id, kind, occurred_at);
create index events_kind_occurred_at on events (kind, occurred_at);

-- ══════════════════════════════════════════════════════════════════════
-- トリガ(SQLite)
-- ══════════════════════════════════════════════════════════════════════

-- 🔴 ポップを作ったら6トリガの行が必ず揃う。既定値(要件書 §4-2)はここ1か所だけが持つ。
create trigger popups_seed_triggers after insert on popups
begin
  insert into popup_triggers (owner_id, popup_id, kind, enabled, threshold) values
    (new.owner_id, new.id, 'back',        1, null),
    (new.owner_id, new.id, 'scroll',      0, 50),
    (new.owner_id, new.id, 'idle',        0, 30),
    (new.owner_id, new.id, 'dwell',       0, 45),
    (new.owner_id, new.id, 'visibility',  0, null),
    (new.owner_id, new.id, 'exit_intent', 1, null);
end;

-- ⚠ トリガの行は「種類ごとに1つ」を主キー (popup_id, kind) が、「種類は6つ」を CHECK が持つ。
--   データ層にトリガの行を足す・消す関数は無い(消えるのはポップ・サイトの削除の cascade)。

-- 🔴 **件数の上限**(本部裁定 §6 裁定2: サイト 20 / ポップ 50 / バリアント 5)。
--   ・値はここと src/lib/data/limits.ts の2か所にある(検査が突き合わせる)
--   ・**アーカイブ済みは数えない**。その代わり**アーカイブから戻すときにも数える**(D-296 5)
--   ・SQLite の行トリガは、**同じ文で先に入れた行も数える**(ローカルの D1 = workerd で実測。
--     サイトは tests/d1-semantics.test.ts、パターンは tests/d1-limits.test.ts。ポップの複数行は撃っていない)。
--     PostgreSQL の WITH CHECK の「1文で複数行入れると全部通る」穴は、測った2つの表では起きなかった
--   ・同時実行: D1 は1つのデータベースのクエリを1つずつ処理する(公式 limits)。
--     判定がトリガ(= 書き込みと同じ文の中)にある限り、2つの要求が同時に「まだ空きがある」を読まない
create trigger sites_limit before insert on sites
when (select count(*) from sites where owner_id = new.owner_id) >= 20
begin
  select raise(abort, 'adpop:limit:sites');
end;

create trigger popups_limit_insert before insert on popups
when new.archived_at is null
  and (select count(*) from popups where site_id = new.site_id and archived_at is null) >= 50
begin
  select raise(abort, 'adpop:limit:popupsPerSite');
end;

create trigger popups_limit_restore before update of archived_at on popups
when old.archived_at is not null and new.archived_at is null
  and (select count(*) from popups where site_id = new.site_id and archived_at is null) >= 50
begin
  select raise(abort, 'adpop:limit:popupsPerSite');
end;

create trigger variants_limit_insert before insert on variants
when new.archived_at is null
  and (select count(*) from variants where popup_id = new.popup_id and archived_at is null) >= 5
begin
  select raise(abort, 'adpop:limit:variantsPerPopup');
end;

create trigger variants_limit_restore before update of archived_at on variants
when old.archived_at is not null and new.archived_at is null
  and (select count(*) from variants where popup_id = new.popup_id and archived_at is null) >= 5
begin
  select raise(abort, 'adpop:limit:variantsPerPopup');
end;

-- 🔴 **変えてはいけない列**(所有者・親・公開用の識別子・トリガの種類)。
--   旧版は列単位の GRANT で塞いでいた。D1 には GRANT が無いので、トリガで止める。
--   ⚠ 親の付け替えを許すと、上限(サイトあたり 50 など)を「作ってから付け替える」で超えられる。
create trigger sites_immutable before update of id, owner_id, site_key on sites
when new.id is not old.id or new.owner_id is not old.owner_id or new.site_key is not old.site_key
begin
  select raise(abort, 'adpop:immutable:sites');
end;

create trigger site_allowed_origins_immutable before update on site_allowed_origins
begin
  select raise(abort, 'adpop:immutable:site_allowed_origins');
end;

create trigger popups_immutable before update of id, owner_id, site_id, public_key on popups
when new.id is not old.id or new.owner_id is not old.owner_id
  or new.site_id is not old.site_id or new.public_key is not old.public_key
begin
  select raise(abort, 'adpop:immutable:popups');
end;

create trigger popup_triggers_immutable before update of owner_id, popup_id, kind on popup_triggers
when new.owner_id is not old.owner_id or new.popup_id is not old.popup_id or new.kind is not old.kind
begin
  select raise(abort, 'adpop:immutable:popup_triggers');
end;

create trigger variants_immutable before update of id, owner_id, popup_id, public_key on variants
when new.id is not old.id or new.owner_id is not old.owner_id
  or new.popup_id is not old.popup_id or new.public_key is not old.public_key
begin
  select raise(abort, 'adpop:immutable:variants');
end;

-- 🔴 計測イベントは書いたら書き換えない(集計の正)。⚠ 止めているのは UPDATE だけで、
--   削除は止めていない(cascade と、PR5 の保持期間の削除が使う)
create trigger events_immutable before update on events
begin
  select raise(abort, 'adpop:immutable:events');
end;
