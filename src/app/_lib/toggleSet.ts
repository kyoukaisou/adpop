/*
  `Set` への「入れる/外す」を不変(immutable)に行う小さな純粋関数。
  `popup/page.tsx` の dirty な VariantCard / busy な VariantCard の集計(複数の子から
  `(id, boolean)` が届く)で、どちらも同じ形の toggle が要るため切り出した。
*/

/** 値が既に同じ状態なら同じ参照を返す(無駄な state 更新・再レンダーを避ける)。 */
export function toggleInSet<T>(set: ReadonlySet<T>, value: T, include: boolean): ReadonlySet<T> {
  const already = set.has(value);
  if (include === already) return set;
  const next = new Set(set);
  if (include) next.add(value);
  else next.delete(value);
  return next;
}
