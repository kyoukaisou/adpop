-- ADPOP 0002(D1): 管理画面のログインと、画像の後始末(PR3b。設計 = notes の ADPOP-PR3b-設計 改訂 v2)。
--
-- 🔴 **追加だけ**(既存の表・索引・トリガは1つも変えない。tests/d1-migration-additive.test.ts がスキーマの差分で見る)。
-- 🔴 REPLACE の守り(0001 の末尾と同じ形)を、新しい表の一意なキーにも置く(tests/d1-replace.test.ts が一覧を突き合わせる)。

-- セッション。🔴 **Cookie の値は保存しない**。保存するのはその SHA-256(D1 が漏れてもセッションを乗っ取れない)
create table admin_sessions (
  token_hash           text primary key
                         check (length(token_hash) = 64 and token_hash not glob '*[^0-9a-f]*'),
  owner_id             text not null references owners (id) on delete cascade,
  -- ログインした時点の ADMIN_PASSWORD_HASH の SHA-256 の先頭 16 桁。パスワードを変えたら一致しなくなる
  password_fingerprint text not null
                         check (length(password_fingerprint) = 16 and password_fingerprint not glob '*[^0-9a-f]*'),
  created_at           text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at           text not null,
  last_seen_at         text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index admin_sessions_owner on admin_sessions (owner_id);

-- ログインの試行(接続元ごと)。🔴 **IP は保存しない**。鍵は「専用の secret で作った日付つきの HMAC」の先頭 32 桁
create table admin_login_attempts (
  key          text primary key check (length(key) = 32 and key not glob '*[^0-9a-f]*'),
  window_start text not null,
  attempts     integer not null default 0 check (attempts >= 0)
);

create trigger admin_sessions_no_replace before insert on admin_sessions
when exists (select 1 from admin_sessions where token_hash = new.token_hash)
begin
  select raise(abort, 'adpop:conflict:admin_sessions');
end;

-- セッションで変えてよいのは last_seen_at だけ
create trigger admin_sessions_immutable before update of token_hash, owner_id, password_fingerprint, created_at, expires_at on admin_sessions
when new.token_hash is not old.token_hash or new.owner_id is not old.owner_id
  or new.password_fingerprint is not old.password_fingerprint
  or new.created_at is not old.created_at or new.expires_at is not old.expires_at
begin
  select raise(abort, 'adpop:immutable:admin_sessions');
end;

create trigger admin_login_attempts_no_replace before insert on admin_login_attempts
when exists (select 1 from admin_login_attempts where key = new.key)
begin
  select raise(abort, 'adpop:conflict:admin_login_attempts');
end;

create trigger admin_login_attempts_immutable before update of key on admin_login_attempts
when new.key is not old.key
begin
  select raise(abort, 'adpop:immutable:admin_login_attempts');
end;

-- 🔴 **R2 から消せなかった画像のキー**(Codex #7 Blocker 2)。消せなかったら、ここに積んで、
--   同じ所有者の次の画像の操作(アップロード・外す・削除)のたびに消し直す(src/lib/data/images.ts)。
--   ⚠ 消し直すまでの間は、キーを知っていれば配信の /img から取れる(キーは推測できない乱数)。
create table pending_image_deletions (
  key        text primary key
               check (length(key) between 43 and 44 and key glob 'images/*.*'
                      and substr(key, 8, 32) not glob '*[^0-9a-f]*' and substr(key, 40, 1) = '.'),
  owner_id   text not null references owners (id) on delete cascade,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts   integer not null default 0 check (attempts >= 0)
);
create index pending_image_deletions_owner on pending_image_deletions (owner_id);

create trigger pending_image_deletions_no_replace before insert on pending_image_deletions
when exists (select 1 from pending_image_deletions where key = new.key)
begin
  select raise(ignore);
end;

create trigger pending_image_deletions_immutable before update of key, owner_id on pending_image_deletions
when new.key is not old.key or new.owner_id is not old.owner_id
begin
  select raise(abort, 'adpop:immutable:pending_image_deletions');
end;
