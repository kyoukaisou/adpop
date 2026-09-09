/*
  頻度制御(要件書 §4-4)の**判定だけ**を持つモジュール。副作用なし・DOM に触らない。
  MIT(このディレクトリのみ)。

  🔴 **保存先は埋め込み先ドメインの `localStorage`**(ファーストパーティ)。
    サーバー側に訪問者の識別子を持たない(要件書 §5-4)。
  ⚠ **localStorage が使えない / 消される環境では抑制が効かない。**
    これは v1 の既知の限界(要件書 §4-4)で、**Cookie にも第三者にも逃がさない**。
    → 読めなかったときは `null`(= 抑制しない)に倒す。**出しすぎる側の故障**を選んでいる。
*/

export const DAY_MS = 24 * 60 * 60 * 1000;

export type VisitorState = {
  /** 直近に**表示した**時刻(ミリ秒)。⚠ 発火ではなく表示。 */
  lastImpressionAt?: number;
  /** 直近の CV。⚠ **PR2 では誰も書かない**(CV 計測タグは PR6)。 */
  conversionAt?: number;
};

export type Frequency = {
  suppressDays: number;
  sessionImpressions: number;
  postConversionDays: number;
};

/** 抑制の理由。`null` = 出してよい。 */
export type SuppressionReason = "days" | "session" | "conversion" | null;

/**
 * @param now       いまの時刻(ミリ秒)
 * @param state     `localStorage` から読んだもの(読めなければ `null`)
 * @param shownInSession このセッションで既に表示した回数
 */
export function suppressionReason(
  now: number,
  state: VisitorState | null,
  shownInSession: number,
  frequency: Frequency,
): SuppressionReason {
  /*
    ⚠ **並びに意味がある**。同時に当てはまるときは「長く効くほう」を理由にする ——
      CV 後(既定30日)> N日再表示しない(既定7日)> セッション内(1回)。
      理由は数字にそのまま出る(§4-7 の `suppressed`)ので、**どれを記録するかを決めておく**。
  */
  if (state && typeof state.conversionAt === "number" && frequency.postConversionDays > 0) {
    if (now - state.conversionAt < frequency.postConversionDays * DAY_MS) return "conversion";
  }
  if (state && typeof state.lastImpressionAt === "number" && frequency.suppressDays > 0) {
    if (now - state.lastImpressionAt < frequency.suppressDays * DAY_MS) return "days";
  }
  /*
    ⚠ `sessionImpressions` は **1ページ1回**とは別の縛り(§4-4)。
      1ページ1回は「発火は最初の1つだけ」でローダが担保する(設定では変えられない)。
  */
  if (shownInSession >= frequency.sessionImpressions) return "session";
  return null;
}

/**
 * 遷移先 URL を**描画の直前にもう一度**確かめる(要件書 §5-3)。
 * 🔴 **0002 の `adpop_is_https_url` と同じ規則を、意図してもう一度書いている。**
 *   要件書は「**保存時と描画時の両方で検査する**」と指定している ——
 *   片方だけだと、DB を直接触られた日に素通りする。
 *   ⚠ **したがってこれは「写し」ではなく「2枚目の関門」**。
 *     片方を緩めたら、もう片方が止める形になっていることが要点。
 * ⚠ `javascript:` / `data:` を弾くのが目的なので、**https 以外は全部落とす**。
 */
export function isSafeDestination(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    /^https:\/\/[^\s<>"']+$/.test(value)
  );
}

/** `content` の文字列フィールドを、**表示してよい形**に落とす(`textContent` にしか入れない)。 */
export function textOf(value: unknown, maxLength = 300): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
