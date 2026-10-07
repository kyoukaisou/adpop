/*
  ポップ設定(名前・頻度)の未保存入力保護(レビュー指摘)。
  VariantCard の dirty 判定(`variantSync.ts`)と同じ考え方: 「最後にサーバーと同期した値」
  (baseline)を持ち、今の入力と違えば dirty。dirty な間は再取得の値で上書きしない。
  そのカード(ここではポップ設定)自身の保存が成功したときだけ baseline を更新する。
*/

export type Frequency = {
  suppressDays: string;
  sessionImpressions: string;
  postConversionDays: string;
  minDisplayDelaySeconds: string;
};

export type PopupSettingsFields = { name: string; frequency: Frequency };

/** baseline が無い(=まだ一度も同期していない)ときは dirty 扱いにしない。 */
export function isPopupSettingsDirty(baseline: PopupSettingsFields | null, current: PopupSettingsFields): boolean {
  if (baseline === null) return false;
  return (
    current.name !== baseline.name ||
    current.frequency.suppressDays !== baseline.frequency.suppressDays ||
    current.frequency.sessionImpressions !== baseline.frequency.sessionImpressions ||
    current.frequency.postConversionDays !== baseline.frequency.postConversionDays ||
    current.frequency.minDisplayDelaySeconds !== baseline.frequency.minDisplayDelaySeconds
  );
}

/** 再取得(load())の結果をポップ設定(名前・頻度)に適用してよいか。dirtyなら適用しない。 */
export function shouldApplyPopupSettingsFromServer(dirty: boolean): boolean {
  return !dirty;
}
