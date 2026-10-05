/*
  管理画面の数値(表示・クリック・閉じた)。API は `src/lib/data/admin.ts` の `getPopupStats`
  (PR5a・本部発注 D-330)がすでに持つ(`GET /sites/:siteId/popups/stats`)。
  このファイルは **画面が読むためだけの型と表示ロジック**(検査の正はサーバー側)。

  🔴 取れなかったとき(通信失敗・500・503)は「—」のまま残し、0 と見分けられるようにする(P-011)。
    `ApiPopupStats`(サーバーの応答)と「—」を表す `null` を、`formatStatCount` の1箇所でだけ混ぜる
    ——呼び出し側(画面)はこの関数を通した文字列をそのまま出すだけでよい。
*/

export type EventCounts = { impression: number; click: number; close: number };
export type ApiPopupStats = { sevenDay: EventCounts; lifetime: EventCounts };
export type ApiPopupStatsMap = Record<string, ApiPopupStats>;

/** `events` の種類。画面はこの3つしか出さない(要件書 §4-7)。 */
export type StatKind = keyof EventCounts;
export type StatPeriod = keyof ApiPopupStats;

/**
 * 件数を表示用の文字列にする。
 * `stats` が `null`(=取得そのものが失敗した)か、そのポップの行が無ければ「—」。
 * 件数がある場合は3桁区切り(見本 `notes/プロダクト事業部/screenshots/2026-10-01-adpop-admin/03-popups-1280.png`
 * が `1,204` の形で出している)。
 */
export function formatStatCount(stats: ApiPopupStatsMap | null, popupId: string, period: StatPeriod, kind: StatKind): string {
  const entry = stats?.[popupId];
  if (entry === undefined) return "—";
  return entry[period][kind].toLocaleString("ja-JP");
}

/**
 * 完全削除の確認ダイアログの文言(画面設計 §3-3・ADPOP-画面設計.md 117行)。
 * 「表示◯件・クリック◯件・閉じた◯件」。数字が取得できていなければ `null`
 * (`ConfirmDeleteDialog` 側が「この操作は元に戻せません。」にフォールバックする)。
 */
export function deleteConfirmStatsText(stats: ApiPopupStatsMap | null, popupId: string): string | null {
  const entry = stats?.[popupId];
  if (entry === undefined) return null;
  const { impression, click, close } = entry.lifetime;
  return `表示 ${impression.toLocaleString("ja-JP")}・クリック ${click.toLocaleString("ja-JP")}・閉じた ${close.toLocaleString("ja-JP")}`;
}
