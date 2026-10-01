/*
  セッションの Cookie(設計 改訂 v2 1-4 / security 監査 L5)。

  本番: `__Host-adpop_session=<token>; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`
  🔴 `__Host-` は「`Secure`・`Domain` 無し・`Path=/`」をブラウザに強制させる接頭辞。
  🔴 **接頭辞と `Secure` を外すのは、要求の URL が `http://` かつホストがループバックのときだけ**。
    **実行時に要求から判定する**(設定値にしない = 使う人が本番で有効にできない)。
  ⚠ `Set-Cookie` の文字列そのものを検査で固定している(フレームワークの既定に頼らない)。
*/

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function isLoopbackHttp(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1");
}

export function sessionCookieName(requestUrl: string): string {
  return isLoopbackHttp(new URL(requestUrl)) ? "adpop_session" : "__Host-adpop_session";
}

export function sessionSetCookie(requestUrl: string, token: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  const secure = !isLoopbackHttp(new URL(requestUrl));
  return [
    `${sessionCookieName(requestUrl)}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
  ].join("; ");
}

export function expiredSessionCookie(requestUrl: string): string {
  return sessionSetCookie(requestUrl, "", 0);
}

/** 要求の Cookie から、この要求の形で使う名前の値だけを取り出す(別の名前の Cookie は見ない)。 */
export function readSessionToken(requestUrl: string, cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  const name = sessionCookieName(requestUrl);
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}
