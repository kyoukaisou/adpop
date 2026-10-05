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
 * `site/page.tsx` の `load()` が、取得結果から次の `stats` state を決める部分だけを切り出した
 * 純粋関数(DOM・React 無しでテストできる。`pageLoad.ts` の `nextLoadErrorState` と同じ考え方)。
 * 🔴 Codex r1 Should fix: 以前は `site`/`popups` の取得が失敗した早期returnの経路で `stats` に
 *   一切触れておらず、**前回表示していた古い数字が残ったまま**だった(取得失敗なのに、数字だけ
 *   最新のふりをする)。`site`/`popups` のどちらかが失敗した = この回の読み込みは丸ごと
 *   信用できないので、数字も必ず `null`(=「—」表示)に戻す。
 */
export function nextStatsState(
  siteOk: boolean,
  popupsOk: boolean,
  statsResult: { ok: true; data: ApiPopupStatsMap } | { ok: false },
): ApiPopupStatsMap | null {
  if (!siteOk || !popupsOk) return null;
  return statsResult.ok ? statsResult.data : null;
}

/**
 * 完全削除の確認ダイアログの文言(画面設計 §3-3・ADPOP-画面設計.md 117行)。
 * 「表示◯件・クリック◯件・閉じた◯件」。
 * 🔴 Codex r1 Should fix: 数字が取得できていないとき、以前は `null` を返して
 *   `ConfirmDeleteDialog` 側が「この操作は元に戻せません。」という**数字に一切触れない文**に
 *   フォールバックしていた。しかしこの確認の目的は「数字も一緒に消えることを伝える」ことなので、
 *   数字が取れていないからといって**その事実自体を画面から消してしまうと、消える数字が
 *   あることをユーザーが知らないまま削除できてしまう**。取れていないときは各項目を「—」にして
 *   明示する(0件と誤読させない P-011 と同じ理由で、取得失敗を「何も無い」と誤読させない)。
 *   常に文字列を返す(`null` は返さない)。
 */
export function deleteConfirmStatsText(stats: ApiPopupStatsMap | null, popupId: string): string {
  const entry = stats?.[popupId];
  if (entry === undefined) return "表示 —・クリック —・閉じた —";
  const { impression, click, close } = entry.lifetime;
  return `表示 ${impression.toLocaleString("ja-JP")}・クリック ${click.toLocaleString("ja-JP")}・閉じた ${close.toLocaleString("ja-JP")}`;
}
