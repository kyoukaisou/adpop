/*
  API が返す値の形(`src/lib/data/admin.ts` の型の写し)。
  ⚠ ここは画面が読むためだけの型。検査の正はサーバー側(body.ts・admin.ts)。
*/

export type ApiSite = { id: string; name: string; siteKey: string; allowedOrigins: string[] };

export type ApiPopupStatus = "draft" | "active" | "paused";
export type ApiPopup = {
  id: string;
  siteId: string;
  name: string;
  status: ApiPopupStatus;
  archivedAt: string | null;
  suppressDays: number;
  sessionImpressions: number;
  postConversionDays: number;
  minDisplayDelaySeconds: number;
};

export type ApiTriggerKind = "back" | "scroll" | "idle" | "dwell" | "visibility" | "exit_intent";
export type ApiTrigger = { kind: ApiTriggerKind; enabled: boolean; threshold: number | null };

export type ApiVariantKind = "text" | "image" | "chatbot";
export type ApiVariantContent = {
  headline?: unknown;
  body?: unknown;
  buttonLabel?: unknown;
  imageKey?: unknown;
};
export type ApiVariant = {
  id: string;
  popupId: string;
  kind: ApiVariantKind;
  content: ApiVariantContent;
  destinationUrl: string;
  archivedAt: string | null;
};

export const SITE_LIMIT = 20;
export const POPUP_LIMIT = 50;
export const VARIANT_LIMIT = 5;

/** `src/admin/body.ts` の parseVariant が受ける形。⚠ `imageAlt` はまだサーバーが受け付けない(§画面のREADME参照)。 */
export type VariantSavePayload = {
  kind: "text" | "image";
  content: { headline: string; body: string; buttonLabel: string };
  destinationUrl: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function variantHeadline(v: ApiVariant): string {
  return text(v.content.headline);
}
export function variantBody(v: ApiVariant): string {
  return text(v.content.body);
}
export function variantButtonLabel(v: ApiVariant): string {
  return text(v.content.buttonLabel);
}
export function variantImageKey(v: ApiVariant): string | null {
  const key = v.content.imageKey;
  return typeof key === "string" ? key : null;
}

/** 「配信中」タグの判定(画面設計 §3-4 の申し送り4: 現状は先頭の非アーカイブ・テキスト種別バリアント)。 */
export function deliverableVariantId(variants: ApiVariant[]): string | null {
  const candidate = variants.find((v) => v.archivedAt === null && v.kind === "text");
  return candidate?.id ?? null;
}
