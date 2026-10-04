/*
  管理画面の API の本文の検査(副作用なし)。
  🔴 **未知の鍵を断る**(security 監査 M6 の入口: `content` に `imageKey` を混ぜて送る、などを入口で止める)。
    ⚠ 止めるのは入口の1枚目。データ層も `content` を3欄から組み直す(2枚目)。
  ⚠ 形の正(Origin・https)は `src/lib/data/shapes.ts`。ここは呼び出すだけ。
*/
import { TEXT_LIMITS } from "../../packages/embed/src/bridge";
import type { VariantInput } from "../lib/data/admin";
import { isHttpsUrl, isOrigin } from "../lib/data/shapes";

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const NAME_MAX = 200;
const SMALLINT_MAX = 32767;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 鍵の集合がちょうど `keys` であること(足りない・余る、のどちらも断る)。 */
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= NAME_MAX;
}

export function parseLogin(body: unknown): Parsed<{ email: string; password: string }> {
  if (!exactKeys(body, ["email", "password"])) return { ok: false, field: "body" };
  if (typeof body.email !== "string" || body.email.length > 254) return { ok: false, field: "email" };
  if (typeof body.password !== "string" || body.password.length > 256) return { ok: false, field: "password" };
  return { ok: true, value: { email: body.email, password: body.password } };
}

export function parseSite(body: unknown): Parsed<{ name: string; allowedOrigins: string[] }> {
  if (!exactKeys(body, ["name", "allowedOrigins"])) return { ok: false, field: "body" };
  if (!name(body.name)) return { ok: false, field: "name" };
  const origins = body.allowedOrigins;
  if (!Array.isArray(origins) || origins.length > 20 || !origins.every(isOrigin)) {
    return { ok: false, field: "allowedOrigins" };
  }
  return { ok: true, value: { name: body.name.trim(), allowedOrigins: origins as string[] } };
}

export function parseName(body: unknown): Parsed<{ name: string }> {
  if (!exactKeys(body, ["name"])) return { ok: false, field: "body" };
  if (!name(body.name)) return { ok: false, field: "name" };
  return { ok: true, value: { name: body.name.trim() } };
}

const FREQUENCY_KEYS = ["suppressDays", "sessionImpressions", "postConversionDays", "minDisplayDelaySeconds"] as const;

export function parseFrequency(
  body: unknown,
): Parsed<{ suppressDays: number; sessionImpressions: number; postConversionDays: number; minDisplayDelaySeconds: number }> {
  if (!exactKeys(body, FREQUENCY_KEYS)) return { ok: false, field: "body" };
  for (const key of FREQUENCY_KEYS) {
    const v = body[key];
    const min = key === "sessionImpressions" ? 1 : 0;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > SMALLINT_MAX) return { ok: false, field: key };
  }
  return {
    ok: true,
    value: {
      suppressDays: body.suppressDays as number,
      sessionImpressions: body.sessionImpressions as number,
      postConversionDays: body.postConversionDays as number,
      minDisplayDelaySeconds: body.minDisplayDelaySeconds as number,
    },
  };
}

export function parseTrigger(body: unknown): Parsed<{ enabled: boolean }> {
  if (!exactKeys(body, ["enabled"]) || typeof body.enabled !== "boolean") return { ok: false, field: "enabled" };
  return { ok: true, value: { enabled: body.enabled } };
}

export function parseVariant(body: unknown): Parsed<VariantInput> {
  if (!exactKeys(body, ["kind", "content", "destinationUrl"])) return { ok: false, field: "body" };
  if (body.kind !== "text" && body.kind !== "image") return { ok: false, field: "kind" };
  const content = body.content;
  if (!exactKeys(content, ["headline", "body", "buttonLabel", "imageAlt"])) return { ok: false, field: "content" };
  for (const key of ["headline", "body", "buttonLabel", "imageAlt"] as const) {
    const v = content[key];
    if (typeof v !== "string" || v.length > TEXT_LIMITS[key]) return { ok: false, field: key };
  }
  if (!isHttpsUrl(body.destinationUrl)) return { ok: false, field: "destinationUrl" };
  const buttonLabel = (content.buttonLabel as string).trim();
  const imageAlt = (content.imageAlt as string).trim();
  /*
    🔴 **画像の説明は、画像型かつボタン文言が空のときだけ必須**(2026-10-04 追補v2 §7-7-1 の5番)。
      ⚠ **1枚目の関門**(入口)。2枚目は `src/lib/data/admin.ts` の `requiresImageAlt`(API を直叩きしても素通りしない)。
  */
  if (body.kind === "image" && buttonLabel === "" && imageAlt === "") return { ok: false, field: "imageAlt" };
  return {
    ok: true,
    value: {
      kind: body.kind,
      content: {
        headline: (content.headline as string).trim(),
        body: (content.body as string).trim(),
        buttonLabel,
        imageAlt,
      },
      destinationUrl: body.destinationUrl,
    },
  };
}

/** 物理削除の確認(数字も消える)。本文は `{"confirm":"delete"}` ちょうど。 */
export function parseDeleteConfirm(body: unknown): Parsed<null> {
  if (!exactKeys(body, ["confirm"]) || body.confirm !== "delete") return { ok: false, field: "confirm" };
  return { ok: true, value: null };
}

/** 本文の無い変更(稼働・停止・アーカイブ・ログアウト)。本文は `{}` ちょうど。 */
export function parseEmpty(body: unknown): Parsed<null> {
  if (!exactKeys(body, [])) return { ok: false, field: "body" };
  return { ok: true, value: null };
}
