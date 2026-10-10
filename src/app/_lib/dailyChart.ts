/*
  `DailyChart`(推移グラフ)の計算ロジックだけを切り出した純粋関数。
  このリポジトリはまだReactコンポーネントの描画検査を持たない(vitest.config.mts参照。
  `environment: "node"`・testing-library系の依存も無い)ため、DOM抜きでテストできる形にしてある。
*/
import type { DailyStatsPoint } from "./stats";

/**
 * 「グラフにデータがあるか」の判定(D-384 Codexレビュー指摘3)。
 * 🔴 このグラフが実際に描く系列は**表示数・クリック数の2つだけ**(閉じた=closeは描かない)。
 *   `close` が1件でもあれば「データあり」と誤判定すると、表示数・クリック数が全日0なのに
 *   「最初のデータを待っています」が消え、0の水平線だけが描かれる(見た目が壊れる)。
 */
export function chartHasData(points: DailyStatsPoint[]): boolean {
  return points.some((p) => p.impression > 0 || p.click > 0);
}

/** 「きりのいい」最大値を作る(例: 187 → 200、42 → 50)。軸の目盛りが読みやすい値になるようにする。 */
export function niceMax(rawMax: number): number {
  if (rawMax <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const normalized = rawMax / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * 目盛りの値(整数・重複なし・昇順)。
 * 🔴 Codexレビュー指摘3: `max` が小さい(1〜4程度)とき、`max/count` の等分割を単純に丸めると
 *   同じ整数に複数回丸められ、目盛りが重複する(例: max=1・count=4 → [0, 0, 1, 1, 1])。
 *   重複した目盛りは、グラフ上で同じ高さに複数の横線が重なって見える(見た目のバグ)上、
 *   Reactの`key`に同じ値を使っていると警告・取り違えの原因にもなる。
 *   `Set` で重複を除いてから返す(結果の本数が `count+1` より少なくなることがあるが、
 *   重複して同じ高さに2本線が重なるより正しい)。
 */
export function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const rounded = Array.from({ length: count + 1 }, (_, i) => Math.round((max / count) * i));
  return [...new Set(rounded)];
}
