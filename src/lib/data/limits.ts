/*
  件数の上限(要件書 §6 裁定2)。**効かせているのは DB のトリガ**(db/migrations/0001_schema.sql)。
  ここは画面に出すための写しで、`tests/d1-limits.test.ts` が**トリガの実際の振る舞い**と突き合わせる。
  ⚠ 「頻度ルール 10」は取り下げ(数える行が無いため)。
*/
export const LIMITS = {
  sites: 20,
  popupsPerSite: 50,
  variantsPerPopup: 5,
} as const;

export type LimitTarget = keyof typeof LIMITS;
