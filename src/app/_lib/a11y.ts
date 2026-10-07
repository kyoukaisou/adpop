/*
  レビュー指摘: 390px で主要な操作のタップ領域が44×44px未満だった
  (ポップカードの編集/停止/アーカイブ、トリガーのスイッチ、許可ドメインの削除ボタン等)。
  🔴 承認済み見本の**見た目は変えない**(文字の大きさ・行間・配置は維持)という制約があるため、
  可視要素はそのまま、`::before` の絶対配置の透明な矩形でヒット領域だけを広げる
  (クリックは祖先の `<button>`/`<a>` にバブルするので、見た目に影響しない)。
  `relative` を前提にするので、既に `relative` を持つ要素には位置用のクラスを足さない。
*/

/**
 * テキストリンク・小さいボタン用。
 * 🔴 レビュー指摘: 以前の `-inset-3.5`(左右14px)は、`gap-x-4`(16px)で並ぶ
 *   「編集/停止/アーカイブ」等の間で隣の疑似要素と約12px重なり、押し間違いが起きた
 *   (重なった領域はDOM順で後の要素が手前になる)。
 * 📌 **横は隣との間隔の半分まで(8px)にとどめて重ならないことを優先し、縦だけ44pxを確保する**
 *   (設計の決定)。見た目の大きさ・位置は変えない。横の実効幅は要素によって44pxに届かないことがあるが、
 *   「重ならない」を優先する。
 */
export const TAP_TARGET_44 = "relative before:absolute before:-inset-y-3 before:-inset-x-2 before:content-['']";

/** 縦方向だけが足りない要素用(例: h-6 のトグルスイッチ)。横幅は変えずに高さだけ44pxに広げる。 */
export const TAP_TARGET_44_V = "relative before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']";

/**
 * アイコンのみの小さいボタン用(許可ドメインの削除 ✕ など)。
 * ⚠ 実測(Playwright): 「✕」の可視領域は幅7px・高さ16px程度しかなく、`-inset-4`(16px)では
 *   幅が 7+32=39px で44pxに届かなかった。`-inset-5`(20px)で 7+40=47px まで確保する。
 */
export const TAP_TARGET_44_ICON = "relative before:absolute before:-inset-5 before:content-['']";
