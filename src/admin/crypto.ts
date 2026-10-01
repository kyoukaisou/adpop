/*
  管理画面の認証で使う暗号の部品(Web Crypto だけ。Node でも Workers でも動く)。
  設計 = notes の ADPOP-PR3b-設計 改訂 v2(security 監査 H1 / M2 / L7)。

  🔴 パスワードは**人が選ばない**。`npm run admin:hash`(scripts/admin-hash.mjs)が 128 ビットの乱数で作る。
    だから反復 100,000 回でも、ハッシュが漏れたときのオフライン総当たりが成立しない(根拠はエントロピー)。
  🔴 本番の Workers は PBKDF2 の反復を 100,000 回までに制限している(workerd の LimitEnforcer の既定実装)。
    ⚠ 手元の workerd(wrangler)には上限が無いので、**手元の検査ではこの上限に当たらない**(README)。
*/

export const PBKDF2_ITERATIONS = 100_000;
const HASH_PATTERN = /^pbkdf2-sha256\$100000\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message))));
}

export async function pbkdf2(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export type PasswordHash = { salt: Uint8Array; hash: Uint8Array };

/**
 * 保存の形を**完全一致で**読む(反復回数を文字列から信じない = 100000 以外は読まない。監査 L7)。
 * 形が違えば `null`(呼び出し側はログインを全部断る)。
 */
export function parsePasswordHash(stored: string | undefined): PasswordHash | null {
  if (typeof stored !== "string") return null;
  const m = HASH_PATTERN.exec(stored.trim());
  if (m === null) return null;
  const salt = fromBase64Url(m[1]);
  const hash = fromBase64Url(m[2]);
  if (salt.byteLength !== 16 || hash.byteLength !== 32) return null;
  return { salt, hash };
}

export function formatPasswordHash(salt: Uint8Array, hash: Uint8Array): string {
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/**
 * 時間差の出ない比較。⚠ **長さが違えば先に false**(長さは秘密ではない: どちらも固定長のハッシュ)。
 * ⚠ Workers の `crypto.subtle.timingSafeEqual` は Node の検査で動かないので、XOR の積み上げで書く。
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * 試行回数の鍵に入れる接続元(監査 M2)。
 * 🔴 **`CF-Connecting-IP` だけを使う**(`X-Forwarded-For` は相手が書ける)。無ければ `unknown` に寄せる(厳しい側)。
 * 🔴 **IPv6 は /64 に丸める**(普通の回線でも /64 を丸ごと持っていて、末尾を変えれば鍵が無限に作れる)。
 */
export function connectingAddress(headerValue: string | null): string {
  const value = (headerValue ?? "").trim();
  if (value === "") return "unknown";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value;
  if (value.includes(":")) {
    const expanded = expandIpv6(value);
    return expanded === null ? "unknown" : `${expanded.slice(0, 4).join(":")}::/64`;
  }
  return "unknown";
}

function expandIpv6(value: string): string[] | null {
  const [head, tail, ...rest] = value.toLowerCase().split("::");
  if (rest.length > 0) return null;
  const left = head ? head.split(":") : [];
  const right = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (tail === undefined && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}
