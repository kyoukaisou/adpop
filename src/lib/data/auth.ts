/*
  管理画面のログインのデータ層(セッション・試行回数)。設計 = notes の ADPOP-PR3b-設計 改訂 v2。

  ⚠ ここは「所有者の行」ではなく**秘密の値(トークンのハッシュ・試行の鍵)**で引く表なので、
    `admin.ts` の「第2引数は ownerId」の規則の外に置く。トークンのハッシュ・鍵は推測できない値で、
    呼び出し側(認証のミドルウェア)が作る。
  ⚠ 時刻は ISO 8601 の文字列(UTC・ミリ秒つき = `Date#toISOString`)。文字列のまま大小を比べる。
*/
import { resolveDb, type DbSource } from "./source";

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ATTEMPTS_PER_WINDOW = 5;

/**
 * 🔴 **試行を1つ足して、足した後の値を返す**(security 監査 M1)。**パスワードを確かめる前**に呼ぶ。
 *   数えるのは失敗ではなく試行。判定と加算を同じ文で行うので、並列の要求でも「まだ0回」を2人が読まない
 *   (D1 は1つのデータベースのクエリを1つずつ処理する + batch は1つのトランザクション)。
 * ⚠ 「無ければ作る」は `insert ... where not exists`(データ層に `ON CONFLICT DO UPDATE` を書かない規則)。
 */
export async function reserveLoginAttempt(source: DbSource, key: string, now: Date): Promise<number> {
  const db = resolveDb(source);
  const nowIso = now.toISOString();
  const windowStartBefore = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString();
  const [, update] = await db.batch([
    db
      .prepare(
        `insert into admin_login_attempts (key, window_start, attempts)
         select ?1, ?2, 0 where not exists (select 1 from admin_login_attempts where key = ?1)`,
      )
      .bind(key, nowIso),
    db
      .prepare(
        `update admin_login_attempts
           set attempts = case when window_start <= ?3 then 1 else attempts + 1 end,
               window_start = case when window_start <= ?3 then ?2 else window_start end
         where key = ?1
         returning attempts`,
      )
      .bind(key, nowIso, windowStartBefore),
  ]);
  return (update.results as Array<{ attempts: number }>)[0]?.attempts ?? Number.MAX_SAFE_INTEGER;
}

/** ログインに成功したら、その接続元の数を消す。窓が過ぎた行もここで掃除する(監査 L8)。 */
export async function clearLoginAttempts(source: DbSource, key: string, now: Date): Promise<void> {
  const db = resolveDb(source);
  await db.batch([
    db.prepare(`delete from admin_login_attempts where key = ?1`).bind(key),
    db
      .prepare(`delete from admin_login_attempts where window_start <= ?1`)
      .bind(new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString()),
  ]);
}

/** 窓が過ぎた試行の行を消す(ログインのたびに呼ぶ。監査 L8)。 */
export async function purgeStaleLoginAttempts(source: DbSource, now: Date): Promise<void> {
  const db = resolveDb(source);
  await db
    .prepare(`delete from admin_login_attempts where window_start <= ?1`)
    .bind(new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString())
    .run();
}

export type SessionRow = {
  owner_id: string;
  password_fingerprint: string;
  expires_at: string;
  last_seen_at: string;
};

/**
 * 期限切れ・無操作のまま時間が過ぎたセッションを消す(所有者の分)。
 * 🔴 **ログインを試みるたびに呼ぶ**(成功したときだけではない = レビュー指摘)。
 */
export async function purgeExpiredSessions(source: DbSource, ownerId: string, now: Date, idleMs: number): Promise<void> {
  const db = resolveDb(source);
  await db
    .prepare(`delete from admin_sessions where owner_id = ?1 and (expires_at <= ?2 or last_seen_at <= ?3)`)
    .bind(ownerId, now.toISOString(), new Date(now.getTime() - idleMs).toISOString())
    .run();
}

/** セッションを作る。 */
export async function createSession(
  source: DbSource,
  session: { tokenHash: string; ownerId: string; fingerprint: string; expiresAt: Date; now: Date },
): Promise<void> {
  const db = resolveDb(source);
  const nowIso = session.now.toISOString();
  await db
    .prepare(
      `insert into admin_sessions (token_hash, owner_id, password_fingerprint, created_at, expires_at, last_seen_at)
       values (?1, ?2, ?3, ?4, ?5, ?4)`,
    )
    .bind(session.tokenHash, session.ownerId, session.fingerprint, nowIso, session.expiresAt.toISOString())
    .run();
}

export async function findSession(source: DbSource, tokenHash: string): Promise<SessionRow | null> {
  const db = resolveDb(source);
  return db
    .prepare(
      `select owner_id, password_fingerprint, expires_at, last_seen_at from admin_sessions where token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<SessionRow>();
}

export async function touchSession(source: DbSource, tokenHash: string, now: Date): Promise<void> {
  const db = resolveDb(source);
  await db
    .prepare(`update admin_sessions set last_seen_at = ?2 where token_hash = ?1`)
    .bind(tokenHash, now.toISOString())
    .run();
}

export async function deleteSession(source: DbSource, tokenHash: string): Promise<void> {
  const db = resolveDb(source);
  await db.prepare(`delete from admin_sessions where token_hash = ?1`).bind(tokenHash).run();
}
