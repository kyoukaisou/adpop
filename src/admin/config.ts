/*
  管理画面の Worker の秘密と設定(すべて **secret**。`wrangler secret put` / ローカルは `.dev.vars`)。
  🔴 **どれか1つでも欠けている・形が違うなら、ログインも API も全部断る**(fail closed・監査 L7)。
    判定はリクエストのたびに行い、**値の中身はログに出さない**。
  🔴 `ADMIN_EMAIL` も secret(監査 L9: `vars` に書くと公開 fork に本人のメールが出る)。
    設定ファイル(wrangler.admin.jsonc)にこれらの鍵が在れば検査が落ちる(tests/admin-config.test.ts)。
*/
import type { Bindings } from "../lib/data/source";
import { isUuid } from "../lib/data/shapes";
import { parsePasswordHash, type PasswordHash } from "./crypto";

export const SECRET_NAMES = ["ADMIN_PASSWORD_HASH", "ADMIN_EMAIL", "ADMIN_OWNER_ID", "ADMIN_RATE_LIMIT_KEY"] as const;

export type AdminEnv = Bindings & Partial<Record<(typeof SECRET_NAMES)[number], string>>;

export type AdminConfig = {
  passwordHash: PasswordHash;
  /** `ADMIN_PASSWORD_HASH` の文字列そのもの(セッションの指紋を作るため) */
  passwordHashText: string;
  email: string;
  ownerId: string;
  rateLimitKey: string;
};

export function readAdminConfig(env: AdminEnv): AdminConfig | null {
  const passwordHash = parsePasswordHash(env.ADMIN_PASSWORD_HASH);
  const email = (env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const ownerId = (env.ADMIN_OWNER_ID ?? "").trim().toLowerCase();
  const rateLimitKey = (env.ADMIN_RATE_LIMIT_KEY ?? "").trim();
  if (passwordHash === null) return null;
  if (email === "" || !email.includes("@")) return null;
  if (!isUuid(ownerId)) return null;
  // 鍵は scripts/admin-hash.mjs が 32 バイトの乱数(base64url で 43 文字)で作る
  if (rateLimitKey.length < 32) return null;
  return { passwordHash, passwordHashText: (env.ADMIN_PASSWORD_HASH ?? "").trim(), email, ownerId, rateLimitKey };
}
