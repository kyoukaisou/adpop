/*
  VariantCard の「保存していない入力を勝手に上書きしない」判定(レビュー指摘)。

  🔴 以前は、親から新しい `variant` props が来たら(他のパターンの保存・アーカイブ、
    ポップ設定の保存、トリガーの切り替え、いずれも一覧全体を再取得する)無条件に
    `applyVariant` していた。**操作中でないこと(busy===false)と、未編集であることは同義ではない**
    ——パターンAを編集中(保存していない)に、無関係な操作Bが一覧を再読み込みさせると、
    Aの入力が警告なく保存済みの値に戻っていた。

  設計の決定:
  - カードごとに「最後にサーバーと同期した値」(baseline)を持つ
  - 今の入力が baseline と異なれば dirty。dirty なカードには props 同期をかけない
  - そのカード自身の保存(または画像の回復処理での再同期)が成功したときだけ baseline を更新する

  この判定自体は DOM・React 無しでテストできる純粋関数にしてある(`variantSync.test.ts`)。
*/
import type { ApiVariant, ApiVariantKind } from "./types";
import { variantBody, variantButtonLabel, variantHeadline, variantImageAlt } from "./types";

/** baseline(=最後にサーバーと同期した値)・現在の入力、どちらも同じ形で比べる。画像キーは含めない(別経路で確定するため)。 */
export type SyncedFields = {
  kind: ApiVariantKind;
  headline: string;
  body: string;
  buttonLabel: string;
  imageAlt: string;
  destinationUrl: string;
};

export function extractSyncedFields(v: ApiVariant): SyncedFields {
  return {
    kind: v.kind === "image" ? "image" : "text",
    headline: variantHeadline(v),
    body: variantBody(v),
    buttonLabel: variantButtonLabel(v),
    imageAlt: variantImageAlt(v),
    destinationUrl: v.destinationUrl,
  };
}

/** baseline が無い(=まだ一度もサーバーと同期していない下書き)ときは dirty 扱いにしない。 */
export function isDirtyFrom(baseline: SyncedFields | null, current: SyncedFields): boolean {
  if (baseline === null) return false;
  return (
    current.kind !== baseline.kind ||
    current.headline !== baseline.headline ||
    current.body !== baseline.body ||
    current.buttonLabel !== baseline.buttonLabel ||
    current.imageAlt !== baseline.imageAlt ||
    current.destinationUrl !== baseline.destinationUrl
  );
}

/** props 同期(useEffect)を適用してよいか。variant が無い・操作中・未保存の変更がある、のどれかなら適用しない。 */
export function shouldApplyPropsSync(params: { hasVariant: boolean; busy: boolean; dirty: boolean }): boolean {
  return params.hasVariant && !params.busy && !params.dirty;
}

/*
  🔴 レビュー指摘: 3巡目のdirtyガードは props 同期の useEffect にしか効いておらず、
    画像だけを確定した経路(差し替え・外す・回復)がカード全体を直接 `applyVariant` して
    文字欄・baselineまで上書きしていた。

  「何を確定したか」で反映する範囲を分ける、1つの純粋関数に集約する:
  - `{ kind: "save" }` = 文字欄を送った経路(新規作成・保存のPUT)。送った値と確定する値が
    一致する前提が成り立つので、文字欄・baseline・imageKey の全部を反映してよい
  - `{ kind: "image-only" }` = 画像だけを確定した経路(差し替え・外す)。**文字欄・baselineには
    触れず**、imageKey だけを反映する
*/

/** サーバーの確定値(画像キーを含む)。`save` 経路で使う。 */
export type VariantServerSnapshot = SyncedFields & { imageKey: string | null };

export type SyncEvent = { kind: "save"; server: VariantServerSnapshot } | { kind: "image-only"; imageKey: string | null };

/** 適用すべき差分。`fields`/`baseline` が `null` = 触れない(直前の値を保つ)。`imageKey` は常に反映する。 */
export type SyncPatch = { fields: SyncedFields | null; baseline: SyncedFields | null; imageKey: string | null };

export function computeSyncPatch(event: SyncEvent): SyncPatch {
  if (event.kind === "image-only") {
    return { fields: null, baseline: null, imageKey: event.imageKey };
  }
  const { imageKey, ...fields } = event.server;
  return { fields, baseline: fields, imageKey };
}
