/*
  新規の画像パターンで「パターンを作成 → 画像をアップロード」の②が失敗した(または応答が
  届かなかった)ときの後始末(Codex 2巡目 Blocker)。

  🔴 以前は補償DELETEの結果を確かめずに握りつぶしていた(404・409・通信失敗を見ていなかった)。
    本部裁定:
    - まず GET で実際の状態を確かめる(消す前に確認する。応答が届かなかっただけで実は成功していた、
      という場合があるため)
    - `imageKey` があれば、アップロードは実は成功していた → 下書きをやめ、保存済みとして扱う
    - `imageKey` が無いときだけ DELETE する。DELETE の結果は必ず確認する
    - DELETE が失敗・409で断られたら、**作ったIDを手放さない**(保存済み・画像なしのパターンとして
      再同期する)。勝手に削除されたことにしない
    - どの経路でも、成功の通知(トースト)は出さない(何らかの異常系を通ったことに変わりないため)

  この関数は副作用(API呼び出し)を `deps` 経由で受け取る純粋な分岐ロジックにしてあり、
  DOM・React無しでテストできる(`variantRecovery.test.ts`)。
*/
import type { ApiResult } from "./api";
import type { ApiVariant } from "./types";
import { variantImageKey } from "./types";

export type RecoveryOutcome =
  /** 応答は失われていたが、実際はアップロードが成功していた。保存済みとして扱ってよい。 */
  | { kind: "recovered"; variant: ApiVariant }
  /** 画像が無いことを確認し、補償DELETEも成功した。まっさらな下書きに戻してよい。 */
  | { kind: "reverted-to-draft" }
  /** 画像が無いが、補償DELETEが失敗・409で断られた。IDは実在するので手放さない。 */
  | { kind: "kept-without-image"; message: string }
  /** 状態そのものを確認できなかった(GET自体が失敗)。安全側に倒し、IDを手放さない。 */
  | { kind: "unknown"; message: string };

export type VariantRecoveryDeps = {
  getVariant: (id: string) => Promise<ApiResult<ApiVariant>>;
  deleteVariant: (id: string) => Promise<ApiResult<unknown>>;
};

export async function recoverFailedImageUpload(variantId: string, deps: VariantRecoveryDeps): Promise<RecoveryOutcome> {
  const check = await deps.getVariant(variantId);
  if (!check.ok) {
    return { kind: "unknown", message: "状態を確認できませんでした。画面を再読み込みして確認してください。" };
  }
  if (variantImageKey(check.data) !== null) {
    return { kind: "recovered", variant: check.data };
  }
  const deleted = await deps.deleteVariant(variantId);
  if (deleted.ok) {
    return { kind: "reverted-to-draft" };
  }
  return { kind: "kept-without-image", message: "画像を保存できませんでした。もう一度画像を選んでください。" };
}
