/*
  管理画面のデータ層。**所有者(owner)の分離はここが持つ**(旧版の RLS の代わり)。

  🔴 **規則**(①③④は検査が直接見る。②は検査が「振る舞い」で見る = 他人として呼ぶと0件):
    ① 公開する関数は**すべて第2引数に `ownerId` を取る**(`tests/d1-owner-isolation.test.ts` が全関数を列挙し、
       他人の owner で呼ぶと「0件 / 見つからない」になることを撃つ。**一覧に無い関数を足すと検査が落ちる**)
    ② 読み取り・更新・削除の SQL は **`owner_id = ?` を必ず条件に入れる**
    ③ 挿入は、親への**複合外部キー (親の id, owner_id)** が他人の親を指す行を断る(DB が最後に判定する)
    ④ D1 のバインドに触ってよいのは `src/lib/data/` の中だけ(`tests/d1-access-boundary.test.ts`)
  ⚠ **守れなくなったもの**: DB が最後の砦ではない。この層のコードの誤り1つで他人の行に届く
    (旧版は RLS が誤りを止めた)。v1 は管理者1人なので、実害の範囲は狭い(README)。
  ⚠ 結果の「0件」は失敗として返す(`not_found`)。成功に見せない。
*/
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { DELIVERABLE_VARIANT } from "./delivery";
import { resolveDb, type DbSource } from "./source";
import { classifyD1Error, type DataFailure } from "./errors";
import { isHttpsUrl, isImageKey, isOrigin } from "./shapes";

export type Result<T> = { ok: true; value: T } | { ok: false; failure: DataFailure | { kind: "not_found" } | { kind: "invalid"; field: string } | { kind: "no_deliverable_variant" } };

export type PopupStatus = "draft" | "active" | "paused";
export type TriggerKind = "back" | "scroll" | "idle" | "dwell" | "visibility" | "exit_intent";
export type VariantKind = "text" | "image";

export type Site = { id: string; name: string; siteKey: string; allowedOrigins: string[] };
export type Popup = {
  id: string;
  siteId: string;
  name: string;
  status: PopupStatus;
  archivedAt: string | null;
  suppressDays: number;
  sessionImpressions: number;
  postConversionDays: number;
  minDisplayDelaySeconds: number;
};
export type Trigger = { kind: TriggerKind; enabled: boolean; threshold: number | null };
export type Variant = {
  id: string;
  popupId: string;
  kind: "text" | "image" | "chatbot";
  content: Record<string, unknown>;
  destinationUrl: string;
  archivedAt: string | null;
};

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function notFound<T>(): Result<T> {
  return { ok: false, failure: { kind: "not_found" } };
}
function invalid<T>(field: string): Result<T> {
  return { ok: false, failure: { kind: "invalid", field } };
}

/** 書き込みを実行し、D1 の断りを分類して返す。⚠ 分類できない失敗(DB に届かない等)は投げ直す。 */
async function write<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await run());
  } catch (error) {
    const failure = classifyD1Error(error);
    if (failure.kind === "unknown") throw error;
    return { ok: false, failure };
  }
}

function changed(result: { meta: { changes: number } }): boolean {
  return result.meta.changes > 0;
}

function parseContent(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/* ─────────────── 所有者 ─────────────── */

/** 所有者の行を用意する(PR3b の認証がログイン時に呼ぶ)。既に在れば何もしない。 */
export async function ensureOwner(source: DbSource, ownerId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return write(async () => {
    await db.prepare(`insert into owners (id) values (?1) on conflict (id) do nothing`).bind(ownerId).run();
    return null;
  });
}

/* ─────────────── サイト ─────────────── */

type SiteRow = { id: string; name: string; site_key: string };

async function originsOf(db: D1Database, ownerId: string, siteIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(siteIds.map((id) => [id, []]));
  if (siteIds.length === 0) return map;
  const rows = await db
    .prepare(
      `select site_id, origin from site_allowed_origins
       where owner_id = ?1 and site_id in (select value from json_each(?2))
       order by origin`,
    )
    .bind(ownerId, JSON.stringify(siteIds))
    .all<{ site_id: string; origin: string }>();
  for (const row of rows.results) map.get(row.site_id)?.push(row.origin);
  return map;
}

export async function listSites(source: DbSource, ownerId: string): Promise<Result<Site[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(`select id, name, site_key from sites where owner_id = ?1 order by created_at, id`)
    .bind(ownerId)
    .all<SiteRow>();
  const origins = await originsOf(db, ownerId, rows.results.map((r) => r.id));
  return ok(
    rows.results.map((r) => ({ id: r.id, name: r.name, siteKey: r.site_key, allowedOrigins: origins.get(r.id) ?? [] })),
  );
}

export async function getSite(source: DbSource, ownerId: string, siteId: string): Promise<Result<Site>> {
  const db = resolveDb(source);
  const row = await db
    .prepare(`select id, name, site_key from sites where id = ?1 and owner_id = ?2`)
    .bind(siteId, ownerId)
    .first<SiteRow>();
  if (row === null) return notFound();
  const origins = await originsOf(db, ownerId, [row.id]);
  return ok({ id: row.id, name: row.name, siteKey: row.site_key, allowedOrigins: origins.get(row.id) ?? [] });
}

function checkOrigins(origins: string[]): boolean {
  return origins.every((origin) => isOrigin(origin));
}

function insertOrigins(db: D1Database, ownerId: string, siteId: string, origins: string[]): D1PreparedStatement[] {
  return [...new Set(origins)].map((origin) =>
    db
      .prepare(`insert into site_allowed_origins (site_id, owner_id, origin) values (?1, ?2, ?3)`)
      .bind(siteId, ownerId, origin),
  );
}

export async function createSite(
  source: DbSource,
  ownerId: string,
  input: { name: string; allowedOrigins: string[] },
): Promise<Result<{ id: string }>> {
  const db = resolveDb(source);
  if (!checkOrigins(input.allowedOrigins)) return invalid("allowedOrigins");
  const id = crypto.randomUUID();
  // ⚠ batch は1つのトランザクション。サイトと許可ドメインは両方入るか、両方入らない
  return write(async () => {
    await db.batch([
      db
        .prepare(`insert into sites (id, owner_id, name, site_key) values (?1, ?2, ?3, ?4)`)
        .bind(id, ownerId, input.name, randomHex(16)),
      ...insertOrigins(db, ownerId, id, input.allowedOrigins),
    ]);
    return { id };
  });
}

/**
 * サイト名と許可ドメインを置き換える。
 * 🔴 許可ドメインの消去と追加は**所有者の条件つき**で、1つのトランザクションで行う。
 *   他人のサイトを指すと、名前の更新は0件・消去も0件・追加は複合外部キーが断る。
 */
export async function updateSite(
  source: DbSource,
  ownerId: string,
  siteId: string,
  input: { name: string; allowedOrigins: string[] },
): Promise<Result<null>> {
  const db = resolveDb(source);
  if (!checkOrigins(input.allowedOrigins)) return invalid("allowedOrigins");
  const exists = await db.prepare(`select 1 from sites where id = ?1 and owner_id = ?2`).bind(siteId, ownerId).first();
  if (exists === null) return notFound();
  return write(async () => {
    await db.batch([
      db
        .prepare(`update sites set name = ?1, updated_at = ${NOW} where id = ?2 and owner_id = ?3`)
        .bind(input.name, siteId, ownerId),
      db.prepare(`delete from site_allowed_origins where site_id = ?1 and owner_id = ?2`).bind(siteId, ownerId),
      ...insertOrigins(db, ownerId, siteId, input.allowedOrigins),
    ]);
    return null;
  });
}

/** 物理削除。⚠ 配下のポップ・パターン・**数字(events)も消える**(cascade)。確認は画面の責任。 */
export async function deleteSite(source: DbSource, ownerId: string, siteId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  const result = await db.prepare(`delete from sites where id = ?1 and owner_id = ?2`).bind(siteId, ownerId).run();
  return changed(result) ? ok(null) : notFound();
}

/* ─────────────── ポップ ─────────────── */

type PopupRow = {
  id: string;
  site_id: string;
  name: string;
  status: PopupStatus;
  archived_at: string | null;
  suppress_days: number;
  session_impressions: number;
  post_conversion_days: number;
  min_display_delay_seconds: number;
};
const POPUP_COLUMNS =
  "id, site_id, name, status, archived_at, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds";

function toPopup(r: PopupRow): Popup {
  return {
    id: r.id,
    siteId: r.site_id,
    name: r.name,
    status: r.status,
    archivedAt: r.archived_at,
    suppressDays: r.suppress_days,
    sessionImpressions: r.session_impressions,
    postConversionDays: r.post_conversion_days,
    minDisplayDelaySeconds: r.min_display_delay_seconds,
  };
}

export async function listPopups(source: DbSource, ownerId: string, siteId: string): Promise<Result<Popup[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(`select ${POPUP_COLUMNS} from popups where site_id = ?1 and owner_id = ?2 order by created_at, id`)
    .bind(siteId, ownerId)
    .all<PopupRow>();
  return ok(rows.results.map(toPopup));
}

export async function getPopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<Popup>> {
  const db = resolveDb(source);
  const row = await db
    .prepare(`select ${POPUP_COLUMNS} from popups where id = ?1 and owner_id = ?2`)
    .bind(popupId, ownerId)
    .first<PopupRow>();
  return row === null ? notFound() : ok(toPopup(row));
}

/** ⚠ 他人のサイトを指すと、複合外部キー (site_id, owner_id) が断る(`foreign_key`)。 */
export async function createPopup(
  source: DbSource,
  ownerId: string,
  siteId: string,
  input: { name: string },
): Promise<Result<{ id: string }>> {
  const db = resolveDb(source);
  const id = crypto.randomUUID();
  return write(async () => {
    await db
      .prepare(`insert into popups (id, owner_id, site_id, public_key, name) values (?1, ?2, ?3, ?4, ?5)`)
      .bind(id, ownerId, siteId, randomHex(16), input.name)
      .run();
    return { id };
  });
}

async function updatePopup(
  db: D1Database,
  ownerId: string,
  popupId: string,
  set: string,
  values: unknown[],
): Promise<Result<null>> {
  const result = await write(() =>
    db
      .prepare(`update popups set ${set}, updated_at = ${NOW} where id = ?1 and owner_id = ?2`)
      .bind(popupId, ownerId, ...values)
      .run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}

export function renamePopup(source: DbSource, ownerId: string, popupId: string, name: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(db, ownerId, popupId, "name = ?3", [name]);
}

export function updateFrequency(
  source: DbSource,
  ownerId: string,
  popupId: string,
  input: { suppressDays: number; sessionImpressions: number; postConversionDays: number; minDisplayDelaySeconds: number },
): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(
    db,
    ownerId,
    popupId,
    "suppress_days = ?3, session_impressions = ?4, post_conversion_days = ?5, min_display_delay_seconds = ?6",
    [input.suppressDays, input.sessionImpressions, input.postConversionDays, input.minDisplayDelaySeconds],
  );
}

export function pausePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(db, ownerId, popupId, "status = case when status = 'active' then 'paused' else status end", []);
}

/** アーカイブ(配信から外す・数字は残す)。⚠ 稼働中のままはアーカイブできない(CHECK)ので同じ更新で停止にする。 */
export function archivePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(
    db,
    ownerId,
    popupId,
    `archived_at = coalesce(archived_at, ${NOW}), status = case when status = 'active' then 'paused' else status end`,
    [],
  );
}

/** アーカイブから戻す。⚠ 戻すとサイトあたりの上限を超えるなら DB のトリガが断る(`limit`)。 */
export function restorePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return updatePopup(db, ownerId, popupId, "archived_at = null", []);
}

/** 物理削除。⚠ **数字(events)も消える**(cascade)。確認は画面の責任。 */
export async function deletePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  const result = await db.prepare(`delete from popups where id = ?1 and owner_id = ?2`).bind(popupId, ownerId).run();
  return changed(result) ? ok(null) : notFound();
}

/**
 * 稼働にする。**同じサイトの稼働中は停止になる**(1サイト1つ)。
 * 🔴 2つの更新を1つのトランザクション(batch)で行い、**両方に同じ条件**
 *   (自分のポップ・アーカイブしていない・配れるパターンがある)を書く。
 *   D1 は1つのデータベースのクエリを1つずつ処理するので、条件は2つの文の間で変わらない
 *   → 条件が偽なら**どちらの文も何も変えない**(「止めたが動かせなかった」を作らない)。
 */
export async function activatePopup(source: DbSource, ownerId: string, popupId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  const eligible = `
    select 1 from popups target
    where target.id = ?1 and target.owner_id = ?2 and target.archived_at is null
      and exists (select 1 from variants where popup_id = target.id and ${DELIVERABLE_VARIANT})`;
  const result = await write(() =>
    db.batch([
      db
        .prepare(
          `update popups set status = 'paused', updated_at = ${NOW}
           where owner_id = ?2 and status = 'active' and id <> ?1
             and site_id = (select site_id from popups where id = ?1 and owner_id = ?2)
             and exists (${eligible})`,
        )
        .bind(popupId, ownerId),
      db
        .prepare(`update popups set status = 'active', updated_at = ${NOW} where id = ?1 and owner_id = ?2 and exists (${eligible})`)
        .bind(popupId, ownerId),
    ]),
  );
  if (!result.ok) return result;
  if (result.value[1].meta.changes === 1) return ok(null);
  // なぜ動かせなかったかを分けて返す(自分のポップで、アーカイブしていないなら「配れるパターンが無い」)
  const popup = await db
    .prepare(`select archived_at from popups where id = ?1 and owner_id = ?2`)
    .bind(popupId, ownerId)
    .first<{ archived_at: string | null }>();
  if (popup === null || popup.archived_at !== null) return notFound();
  return { ok: false, failure: { kind: "no_deliverable_variant" } };
}

/* ─────────────── トリガ ─────────────── */

export async function listTriggers(source: DbSource, ownerId: string, popupId: string): Promise<Result<Trigger[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(`select kind, enabled, threshold from popup_triggers where popup_id = ?1 and owner_id = ?2`)
    .bind(popupId, ownerId)
    .all<{ kind: TriggerKind; enabled: number; threshold: number | null }>();
  return ok(rows.results.map((r) => ({ kind: r.kind, enabled: r.enabled === 1, threshold: r.threshold })));
}

export async function setTriggerEnabled(
  source: DbSource,
  ownerId: string,
  popupId: string,
  kind: TriggerKind,
  enabled: boolean,
): Promise<Result<null>> {
  const db = resolveDb(source);
  const result = await db
    .prepare(
      `update popup_triggers set enabled = ?1, updated_at = ${NOW} where popup_id = ?2 and owner_id = ?3 and kind = ?4`,
    )
    .bind(enabled ? 1 : 0, popupId, ownerId, kind)
    .run();
  return changed(result) ? ok(null) : notFound();
}

/* ─────────────── パターン(バリアント) ─────────────── */

type VariantRow = {
  id: string;
  popup_id: string;
  kind: Variant["kind"];
  content: string;
  destination_url: string;
  archived_at: string | null;
};
const VARIANT_COLUMNS = "id, popup_id, kind, content, destination_url, archived_at";

function toVariant(r: VariantRow): Variant {
  return {
    id: r.id,
    popupId: r.popup_id,
    kind: r.kind,
    content: parseContent(r.content),
    destinationUrl: r.destination_url,
    archivedAt: r.archived_at,
  };
}

export async function listVariants(source: DbSource, ownerId: string, popupId: string): Promise<Result<Variant[]>> {
  const db = resolveDb(source);
  const rows = await db
    .prepare(`select ${VARIANT_COLUMNS} from variants where popup_id = ?1 and owner_id = ?2 order by created_at, id`)
    .bind(popupId, ownerId)
    .all<VariantRow>();
  return ok(rows.results.map(toVariant));
}

export async function getVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<Variant>> {
  const db = resolveDb(source);
  const row = await db
    .prepare(`select ${VARIANT_COLUMNS} from variants where id = ?1 and owner_id = ?2`)
    .bind(variantId, ownerId)
    .first<VariantRow>();
  return row === null ? notFound() : ok(toVariant(row));
}

export type VariantInput = {
  kind: VariantKind;
  content: { headline: string; body: string; buttonLabel: string };
  destinationUrl: string;
};

/**
 * 🔴 `content` の JSON は**3欄から自分で組み直す**(呼び出し側のオブジェクトを `stringify` しない)。
 *   型は3欄でも、実行時には何でも通る。そのまま入れると `imageKey` を外から書けた(security 監査 M6)。
 *   `imageKey` を書けるのは `setVariantImage` だけ。
 */
function textContent(input: VariantInput): string {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return JSON.stringify({
    headline: text(input.content?.headline),
    body: text(input.content?.body),
    buttonLabel: text(input.content?.buttonLabel),
  });
}


/** ⚠ 他人のポップを指すと、複合外部キー (popup_id, owner_id) が断る(`foreign_key`)。 */
export async function createVariant(
  source: DbSource,
  ownerId: string,
  popupId: string,
  input: VariantInput,
): Promise<Result<{ id: string }>> {
  const db = resolveDb(source);
  if (!isHttpsUrl(input.destinationUrl)) return invalid("destinationUrl");
  const id = crypto.randomUUID();
  return write(async () => {
    await db
      .prepare(
        `insert into variants (id, owner_id, popup_id, public_key, kind, content, destination_url)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(id, ownerId, popupId, randomHex(16), input.kind, textContent(input), input.destinationUrl)
      .run();
    return { id };
  });
}

/**
 * パターンの編集。⚠ **計測はリセットしない**(要件書 §6 裁定6)。
 * 文字の3欄だけを差し替える。**画像のキー(`imageKey`)は元の値を残す**(書けるのは `setVariantImage` だけ)。
 */
export async function updateVariant(
  source: DbSource,
  ownerId: string,
  variantId: string,
  input: VariantInput,
): Promise<Result<null>> {
  const db = resolveDb(source);
  if (!isHttpsUrl(input.destinationUrl)) return invalid("destinationUrl");
  const result = await write(() =>
    db
      .prepare(
        `update variants set kind = ?1,
           content = case when json_extract(content, '$.imageKey') is null then ?2
                          else json_set(?2, '$.imageKey', json_extract(content, '$.imageKey')) end,
           destination_url = ?3, updated_at = ${NOW}
         where id = ?4 and owner_id = ?5`,
      )
      .bind(input.kind, textContent(input), input.destinationUrl, variantId, ownerId)
      .run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}

async function setVariantArchived(
  db: D1Database,
  ownerId: string,
  variantId: string,
  archived: boolean,
): Promise<Result<null>> {
  const result = await write(() =>
    db
      .prepare(
        `update variants set archived_at = ${archived ? `coalesce(archived_at, ${NOW})` : "null"}, updated_at = ${NOW}
         where id = ?1 and owner_id = ?2`,
      )
      .bind(variantId, ownerId)
      .run(),
  );
  if (!result.ok) return result;
  return changed(result.value) ? ok(null) : notFound();
}

export function archiveVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return setVariantArchived(db, ownerId, variantId, true);
}

/** ⚠ 戻すとポップあたりの上限を超えるなら DB のトリガが断る(`limit`)。 */
export function restoreVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  return setVariantArchived(db, ownerId, variantId, false);
}

/** 物理削除。⚠ **数字(events)も消える**(cascade)。確認は画面の責任。 */
export async function deleteVariant(source: DbSource, ownerId: string, variantId: string): Promise<Result<null>> {
  const db = resolveDb(source);
  const result = await db.prepare(`delete from variants where id = ?1 and owner_id = ?2`).bind(variantId, ownerId).run();
  return changed(result) ? ok(null) : notFound();
}

/**
 * パターンの画像のキーを書く(R2 に置くのは `images.ts` の仕事。ここは DB の1欄だけ)。
 * 🔴 **`imageKey` を書く唯一の関数**。キーの形を確かめてから書き、**前のキーを返す**(呼び出し側が R2 から消す)。
 * ⚠ batch(1つのトランザクション)で「前の値を読む」と「書く」を行う。
 */
export async function setVariantImage(
  source: DbSource,
  ownerId: string,
  variantId: string,
  key: string | null,
): Promise<Result<{ previousKey: string | null }>> {
  const db = resolveDb(source);
  if (key !== null && !isImageKey(key)) return invalid("imageKey");
  const result = await write(() =>
    db.batch([
      db
        .prepare(`select json_extract(content, '$.imageKey') as previous from variants where id = ?1 and owner_id = ?2`)
        .bind(variantId, ownerId),
      db
        .prepare(
          `update variants set content = ${key === null ? "json_remove(content, '$.imageKey')" : "json_set(content, '$.imageKey', ?3)"},
             updated_at = ${NOW}
           where id = ?1 and owner_id = ?2`,
        )
        .bind(...(key === null ? [variantId, ownerId] : [variantId, ownerId, key])),
    ]),
  );
  if (!result.ok) return result;
  const [read, update] = result.value;
  if (update.meta.changes === 0) return notFound();
  const previous = (read.results as Array<{ previous: unknown }>)[0]?.previous;
  return ok({ previousKey: isImageKey(previous) ? previous : null });
}

/** 所有者の配下にある画像のキー(サイト・ポップ・パターンを消す前に集める = 消したあと R2 からも消すため)。 */
export async function imageKeysUnder(
  source: DbSource,
  ownerId: string,
  scope: { siteId: string } | { popupId: string } | { variantId: string },
): Promise<Result<string[]>> {
  const db = resolveDb(source);
  const [column, value] =
    "siteId" in scope
      ? ["p.site_id", scope.siteId]
      : "popupId" in scope
        ? ["v.popup_id", scope.popupId]
        : ["v.id", scope.variantId];
  const rows = await db
    .prepare(
      `select json_extract(v.content, '$.imageKey') as key from variants v
       join popups p on p.id = v.popup_id
       where v.owner_id = ?1 and ${column} = ?2 and json_extract(v.content, '$.imageKey') is not null`,
    )
    .bind(ownerId, value)
    .all<{ key: unknown }>();
  return ok(rows.results.map((r) => r.key).filter(isImageKey));
}
