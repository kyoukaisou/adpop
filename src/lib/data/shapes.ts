/*
  値の「形」の判定(副作用なし)。**配信と管理画面が同じ関数を使う。**

  🔴 PostgreSQL 版では、これらは DB の CHECK(正規表現)が最後に判定していた。
    **D1(SQLite)には正規表現が無い**ので、DB に残せたのは GLOB / LIKE で書ける範囲だけ
    (db/migrations/0001_schema.sql)。**完全な判定はここ**で、許可ドメイン・遷移先 URL・page_url を書く
    データ層の関数は、書く前にここを通す。
  ⚠ したがって「DB を直接触られたとき(wrangler d1 execute 等)」に通る形は旧版より広い。
    README の「D1 に移して弱くなった守り」に書いてある。
  ⚠ Node 固有の import を足さない(Workers で動く)。
*/

/** 旧 0002 `adpop_is_origin` の写し。https + ホスト名(ドットを1つ以上)+ 任意のポート。 */
const ORIGIN_PATTERN =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;

/** 旧 0002 `adpop_is_https_url` の写し(埋め込みの `isSafeDestination` と同じ規則)。 */
const HTTPS_URL_PATTERN = /^https:\/\/[^\s<>"']+$/;

/** 旧 0002 の `events.page_url` の CHECK の写し。origin + path だけ・ホストに `@` を含まない。 */
const PAGE_URL_PATTERN = /^https?:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/;

export const MAX_URL_LENGTH = 2048;
export const MAX_ORIGIN_LENGTH = 300;

export function isHex32(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

export function isOrigin(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ORIGIN_LENGTH && ORIGIN_PATTERN.test(value);
}

export function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_URL_LENGTH && HTTPS_URL_PATTERN.test(value);
}

/**
 * 計測イベントの `pageUrl` を **origin + path** に削る(要件書 §6 裁定4)。
 * 🔴 query と fragment を**削ってから**形を見る。削っても形が合わなければ `invalid`(黙って null にしない)。
 * @returns `null` = 送られてこなかった(空文字も含む)
 */
export function normalizePageUrl(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const cut = trimmed.split("#")[0].split("?")[0];
  if (cut.length > MAX_URL_LENGTH || !PAGE_URL_PATTERN.test(cut)) return { ok: false };
  return { ok: true, value: cut };
}
