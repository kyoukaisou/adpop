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

/** 画像のキーの形(`images/<32桁の16進>.<拡張子>`)。R2 に渡す前・配信で読む前に通す。 */
export function isImageKey(value: unknown): value is string {
  return typeof value === "string" && /^images\/[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(value);
}

/**
 * 値を「比較してよい文字列」に正規化する(欠落・`null`・文字列でないもの・空白だけ → すべて空扱い)。
 * 🔴 **fail-closed に倒す側**(Codex #8 1巡目 Blocker 3): `undefined?.trim()`(= `undefined`)を
 *   `""` と直接比較すると常に偽になり、「空」を見逃して必須判定が素通りする。先に空文字へ倒してから
 *   比較することで、欠落も空文字も同じ扱いになる。
 */
export function normalizeToText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 🔴 **画像の説明(`imageAlt`)は、画像型かつボタン文言が空のときだけ必須**
 *   (2026-10-04 追補v2 §7-7-1 の5番。画像だけのバナーでは、空のままだと読み上げの手がかりが
 *   汎用文言(`buttonLabel` の既定値)だけになる)。
 * 🔴 **保存 API の入口(`src/admin/body.ts`)とデータ層(`src/lib/data/admin.ts`)の両方が、
 *   この1つの関数をそのまま呼ぶ**(Codex #8 1巡目 Blocker 3。定義を2か所に複製すると、片方だけ
 *   直して fail-open が再発する)。`admin.ts` に置かないのは、`tests/d1-owner-isolation.test.ts` が
 *   「データ層が公開する関数はすべて `ownerId` を2番目の引数に取る」ことを機械で検査しており、
 *   DB に触らないこの純粋関数を `admin.ts` から export すると無関係にその検査を壊すため
 *   (`shapes.ts` は配信・管理画面が共有する「値の形の判定」の置き場 = 元からその種の関数の家)。
 * ⚠ **DB の CHECK には入れていない**(限界として記録): SQLite の CHECK は同じ行の他の列を
 *   参照できるので条件自体は書けるが、既存の表に CHECK を追加するには表の再生成が要り、
 *   0002 の「追加だけ」の方針(security 監査 M9)と緊張する。v1 はこの2枚(body.ts + admin.ts)を正とする。
 * ⚠ **既存データの移行は不要**(本部裁定): 本番の Cloudflare には ADPOP のリソースがまだ0件で、
 *   移行すべき既存の行が無い(D-299)。
 */
export function requiresImageAlt(input: { kind: unknown; content?: { buttonLabel?: unknown; imageAlt?: unknown } }): boolean {
  return input.kind === "image" && normalizeToText(input.content?.buttonLabel) === "" && normalizeToText(input.content?.imageAlt) === "";
}
