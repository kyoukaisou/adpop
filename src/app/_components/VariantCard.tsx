"use client";

/*
  パターン(バリアント)の編集カード(画面設計 §3-4・§7-2・§7-7)。
  `variant` が null = まだ作っていない空き枠(「+ パターンを追加」で生まれた下書き)。

  🔴 代替テキスト(画像の説明・imageAlt)は #8(画像ポップの配信)でスキーマに入った。
    `src/admin/body.ts` の `parseVariant` が `content` に4つ目の鍵として要求し、
    `requiresImageAlt`(画像型・ボタン文言が空のときだけ必須)を入口とデータ層の両方で見る。
    この画面の必須判定(`altRequired`/`altMissing`)は、その関数と同じ条件(kind==="image" かつ
    buttonLabelが空かつimageAltが空)を使う——判定がサーバーとずれると、画面では送れたのに
    サーバーが400で断る/画面で止めたのにサーバーは通る、という食い違いが起きるため。

  🔴 Codex 1巡目 Blocker 2 の対応方針(画像の無い画像パターンを保存させない):
    **新しく作る画像パターンは、画像を選んでも「画面の中だけの下書き」のまま持ち、
    実際にAPIへ送るのは「保存」を押した瞬間だけ**にした(先にバリアントだけ作る方式は採らない)。
    「保存」ボタンは画像が選ばれていない間は無効化する。保存の処理順序は
    ①パターンを作成 → ②選んでおいた画像をアップロード、の順で、
    **②が失敗したら①で作ったパターンを消す**(補償のDELETE)。これにより、
    アップロード失敗時に中身の無いパターンがDBに残らない。
    既に保存済みのパターン(画像の差し替え・外した後の選び直し)は、この限りではなく即アップロードする
    (そのパターン自体は差し替え前から有効なレコードとして既に存在しているため)。

  🔴 Codex 1巡目 Should fix(P-012): 保存・アップロード・画像の削除が成功したら、
    サーバーへ `GET /variants/:id` を取りに行って**サーバーが実際に持っている値で画面の状態を置き換える**
    (`syncFromServer`)。trimされた値やimageKeyを、送った値をそのまま仮定して表示しない。

  🔴 Codex 2巡目 Blocker: 新規画像パターンで、作成直後のアップロードが失敗したときの補償DELETEの
    結果を確かめていなかった(404・409・通信失敗を黙って握りつぶしていた)。
    `src/app/_lib/variantRecovery.ts` の `recoverFailedImageUpload` に分岐ロジックを切り出し、
    まずGETで実際の状態を確認してから、消す/消さないを決める(詳細はそのファイルのコメント参照)。

  🔴 Codex 2巡目 Should fix 1(P-012の残り): `syncFromServer` が失敗したときに成功扱いしない
    (`onSaved({ silent: true, errorMessage })` で親にエラーを伝える)。また、親から新しい
    `variant` props が来たとき(他のカードの保存・一覧の再読み込み等)にもこのカードの表示を
    合わせる(`useEffect` で同期。保存・アップロード中は上書きしない)。

  🔴 Codex 3巡目 Blocker: 上のprops同期が、**保存していない入力まで上書きしていた**。
    パターンAを編集中(保存前)に、別の操作(トリガー切替・ポップ設定の保存・別パターンBの
    保存/アーカイブ)が一覧全体を再読み込みさせると、Aの入力が警告なく保存済みの値に戻っていた
    ——「操作中でないこと(busy)」と「未編集であること」は同義ではない。
    `src/app/_lib/variantSync.ts` に dirty 判定を切り出し、**最後にサーバーと同期した値(baseline)
    と今の入力が違うカードには props 同期をかけない**。そのカード自身の保存・画像の回復処理での
    再同期が成功したときだけ baseline を更新する(`markSynced`)。

  🔴 Codex 4巡目 Blocker: 3巡目のdirtyガードは**props同期のeffectにしか効いていなかった**。
    既存パターンの文字欄を編集中(未保存)のまま「差し替え」で画像を選ぶと、アップロード成功後の
    直接の再同期(`uploadToExisting` → 旧`syncFromServer` → `applyVariant`)が、
    dirtyを見ずにカード全体をサーバーの古い文字の値で上書きしていた。
    `applyVariant`/`syncFromServer`/`syncImageFromServer` の呼び出し経路を洗い出し、
    「何を確定したか」で反映する範囲を分けた(表はPR本文):
    - 文字欄を送った経路(保存・新規作成時のアップロード)→ `syncFromServer`(全部を反映してよい。
      送った値と確定する値が一致する前提が成り立つ)
    - 画像だけを確定した経路(既存パターンの差し替え・外す)→ 画像の状態(`imageKey`)だけを反映し、
      文字欄・baselineには触れない(差し替え=`syncImageFromServer`、外す=DELETEの結果を直接反映)
*/
import { useEffect, useRef, useState } from "react";
import { deleteJson, getJson, postJson, putJson, uploadVariantImage } from "../_lib/api";
import { deliveryImageUrl } from "../_lib/delivery";
import { imageErrorMessage } from "../_lib/imageErrors";
import { ApiVariant, ApiVariantKind, variantImageKey } from "../_lib/types";
import { recoverFailedImageUpload } from "../_lib/variantRecovery";
import {
  computeSyncPatch,
  extractSyncedFields,
  isDirtyFrom,
  shouldApplyPropsSync,
  type SyncedFields,
  type SyncPatch,
} from "../_lib/variantSync";
import { FieldError } from "../_components/ErrorBanner";

export type VariantSavedOptions = { silent?: boolean; errorMessage?: string };

const FIELD_LABELS: Record<string, string> = {
  headline: "見出し",
  body: "本文",
  buttonLabel: "ボタン文言",
  imageAlt: "画像の説明",
  destinationUrl: "遷移先URL",
  kind: "種類",
  content: "入力内容",
};

/** #8 の `last_deliverable_variant`(409)。サーバーが message を一緒に返すので、それをそのまま出す。 */
function lastDeliverableMessage(message: string | undefined): string {
  return message ?? "稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください";
}

function isValidHttpsUrl(value: string): boolean {
  return /^https:\/\/[^\s<>"']+$/.test(value) && value.length <= 2048;
}

export function VariantCard({
  variant,
  isDeliverable,
  popupId,
  onSaved,
  onArchived,
  onCancelDraft,
  onDirtyChange,
  onBusyChange,
}: {
  variant: ApiVariant | null;
  isDeliverable: boolean;
  popupId: string;
  onSaved: (options?: VariantSavedOptions) => Promise<void> | void;
  onArchived: (() => Promise<void> | void) | null;
  onCancelDraft: (() => void) | null;
  /**
   * 🔴 ページを離れるときの確認(本部発注)。このカードの `dirty`(=既存の判定。新しい判定は作らない)を
   *   そのまま親へ知らせるだけ。下書きカード(variant===null)は呼ばない——`isDirtyFrom` は
   *   baseline が無い下書きを常に dirty=false にする設計(下のコメント参照)だが、下書きの存在
   *   そのものは親が `draftKeys` で既に把握しているので、ここで重ねて判定を作らない。
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * 🔴 Codex r1 Should fix: 保存・アップロード・画像削除が**進行中**であることを親へ知らせる。
   *   `dirty`(=未保存の入力差分)とは別の状態——画像の差し替えのような「即時送信」の操作は
   *   文字欄が dirty でなくても、送信中に離脱するとリクエストが中断される。下書きカードも
   *   アップロード中はこれを呼ぶ(dirtyと違い、下書きかどうかを区別しない)。
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const initialBaseline = variant ? extractSyncedFields(variant) : null;
  const [kind, setKind] = useState<ApiVariantKind>(initialBaseline?.kind ?? "text");
  const [headline, setHeadline] = useState(initialBaseline?.headline ?? "");
  const [body, setBody] = useState(initialBaseline?.body ?? "");
  const [buttonLabel, setButtonLabel] = useState(initialBaseline?.buttonLabel ?? "");
  const [destinationUrl, setDestinationUrl] = useState(initialBaseline?.destinationUrl ?? "");
  const [imageAlt, setImageAlt] = useState(initialBaseline?.imageAlt ?? "");
  const [showErrors, setShowErrors] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(variant?.id ?? null);
  const [imageKey, setImageKey] = useState<string | null>(variant ? variantImageKey(variant) : null);
  // 🔴 Codex 3巡目 Blocker: 「最後にサーバーと同期した値」。これと今の入力が違うカードには
  //   親からの新しい variant props を適用しない(未保存の入力を勝手に上書きしない)。
  const [baseline, setBaseline] = useState<SyncedFields | null>(initialBaseline);
  // 🔴 下書き(savedId===null)が選んだがまだアップロードしていないファイル(Blocker 2 対応)
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "uploading" | "removing-image">("idle");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const isDraft = savedId === null;
  const destinationUrlOk = isValidHttpsUrl(destinationUrl);
  const altRequired = kind === "image" && buttonLabel.trim() === "";
  const altMissing = altRequired && imageAlt.trim() === "";
  const hasImage = imageKey !== null || pendingFile !== null;
  const imageMissing = kind === "image" && !hasImage;
  const busy = status !== "idle";
  const dirty = isDirtyFrom(baseline, { kind, headline, body, buttonLabel, imageAlt, destinationUrl });

  // 🔴 ページを離れるときの確認(本部発注)。既存の `dirty` をそのまま親へ知らせる。
  //   `onDirtyChange` を effect の依存に入れると、親が毎レンダーで新しい関数を渡した場合に
  //   不要な再実行が起きるため、最新の関数は ref で読む(settingsDirtyRef と同じ理由)。
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  // アンマウント時(アーカイブ・削除でカードが一覧から消えるとき)に dirty の記録を残さない。
  useEffect(() => {
    return () => onDirtyChangeRef.current?.(false);
  }, []);

  // 🔴 busy(保存・アップロード・画像削除の進行中)も同じ形で親へ伝える(dirtyとは別の状態)。
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });
  useEffect(() => {
    onBusyChangeRef.current?.(busy);
  }, [busy]);
  useEffect(() => {
    return () => onBusyChangeRef.current?.(false);
  }, []);

  // オブジェクトURLの後始末
  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
  }, [pendingPreviewUrl]);

  /**
   * 🔴 Codex 4巡目 Blocker: 「何を確定したか」で反映する範囲を分ける判定(`computeSyncPatch`)を
   *   実際に適用する唯一の入口。`patch.fields`/`patch.baseline` が `null` のときは触れない
   *   (画像だけの操作で、文字欄・baselineを上書きしないため)。
   */
  function applyPatch(patch: SyncPatch) {
    if (patch.fields) {
      setKind(patch.fields.kind);
      setHeadline(patch.fields.headline);
      setBody(patch.fields.body);
      setButtonLabel(patch.fields.buttonLabel);
      setImageAlt(patch.fields.imageAlt);
      setDestinationUrl(patch.fields.destinationUrl);
    }
    if (patch.baseline) setBaseline(patch.baseline);
    setImageKey(patch.imageKey);
  }

  /** 「保存」経路(文字欄を送った直後)の patch を作って適用する。baseline も一緒に更新する。 */
  function applySavedVariant(v: ApiVariant) {
    setSavedId(v.id);
    applyPatch(computeSyncPatch({ kind: "save", server: { ...extractSyncedFields(v), imageKey: variantImageKey(v) } }));
  }

  /**
   * 🔴 Codex 2巡目 Should fix 1 → 3巡目 Blocker で条件を追加: 親から新しい `variant` props が
   *   来たら(他のカードの保存・一覧の再読み込み等)、このカードの表示をそれに合わせる。
   *   ただし **保存・アップロード中(busy)**、または **未保存の変更がある(dirty)** ときは
   *   自分の入力・操作結果を上書きしてしまうため同期しない。下書き(variant===null)も対象外。
   */
  useEffect(() => {
    if (!shouldApplyPropsSync({ hasVariant: variant !== null, busy, dirty })) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 親から来た新しいvariantへ意図的に同期する(dirtyでない場合だけ)
    applySavedVariant(variant as ApiVariant);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- variant.content は毎回新しいオブジェクトなので、その変化だけを見る
  }, [variant?.id, variant?.content, variant?.destinationUrl, variant?.archivedAt, busy, dirty]);

  /**
   * 保存(文字欄を送った直後)の後、サーバーが実際に持っている値で画面を置き換える(P-012対応)。
   * 🔴 Codex 2巡目 Should fix 1: この取得自体が失敗したら呼び出し側は**成功の通知を出さない**
   *   (戻り値で知らせる。黙って諦めない)。
   * 🔴 Codex 4巡目 Blocker: **文字欄を送っていない経路(画像だけの操作)ではこれを呼ばない**
   *   (`syncImageFromServer` を使う)。ここは「保存」経路専用——呼ぶのは、今の入力をそのまま
   *   サーバーに送った直後だけ(= 送った値と確定する値が一致する前提が成り立つとき)。
   */
  async function syncFromServer(id: string): Promise<boolean> {
    const result = await getJson<ApiVariant>(`/variants/${id}`);
    if (!result.ok) return false;
    applySavedVariant(result.data);
    return true;
  }

  /**
   * 🔴 Codex 4巡目 Blocker: 既存パターンの画像だけの操作(差し替え)の後に `syncFromServer`
   *   (= 文字欄とbaselineも上書きする「保存」の patch)を呼んでいたため、文字欄を編集中(未保存)の
   *   まま画像を差し替えると入力が消えていた。**画像だけを確定した経路では、`computeSyncPatch` に
   *   `{ kind: "image-only" }` を渡し、imageKey だけを反映する(文字欄・baselineには触れない)。**
   */
  async function syncImageFromServer(id: string): Promise<boolean> {
    const result = await getJson<ApiVariant>(`/variants/${id}`);
    if (!result.ok) return false;
    applyPatch(computeSyncPatch({ kind: "image-only", imageKey: variantImageKey(result.data) }));
    return true;
  }

  function selectFile() {
    fileInputRef.current?.click();
  }

  function handleFileChosen(file: File) {
    setError(null);
    if (!isDraft) {
      // 既に保存済みのパターン: このパターン自体は既に有効なレコードなので、差し替えは即アップロードする
      void uploadToExisting(savedId!, file);
      return;
    }
    // 下書き: まだAPIに送らず、画面の中だけで持つ(保存を押すまでアップロードしない)
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingFile(file);
    setPendingPreviewUrl(URL.createObjectURL(file));
  }

  function clearPendingFile() {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingFile(null);
    setPendingPreviewUrl(null);
  }

  async function uploadToExisting(id: string, file: File) {
    setStatus("uploading");
    setUploadProgress(0);
    setError(null);
    const result = await uploadVariantImage(id, file, setUploadProgress);
    setStatus("idle");
    setUploadProgress(null);
    if (!result.ok) {
      setError(imageErrorMessage(result.reason, result.message));
      return;
    }
    // 🔴 Codex 4巡目 Blocker: 画像だけの操作(差し替え)。文字欄・baselineは触らない
    const synced = await syncImageFromServer(id);
    if (!synced) {
      setError("アップロードはできましたが、最新の状態を確認できませんでした。画面を再読み込みしてください。");
      await onSaved({ silent: true });
      return;
    }
    await onSaved();
  }

  async function removeImage() {
    if (savedId === null || submittingRef.current) return;
    submittingRef.current = true;
    setStatus("removing-image");
    const result = await deleteJson<unknown>(`/variants/${savedId}/image`, {});
    submittingRef.current = false;
    setStatus("idle");
    if (!result.ok) {
      if (result.reason === "last_deliverable_variant") {
        setError(lastDeliverableMessage(result.message));
      } else {
        setError("画像を外せませんでした。もう一度お試しください。");
      }
      return;
    }
    // 🔴 画像だけの操作(外す)。DELETEの結果からimageKeyがnullになったことだけ分かっているので、
    //   それだけを反映する(GETし直さない。文字欄・baselineには触れない。Codex 4巡目 Blocker参照)
    applyPatch(computeSyncPatch({ kind: "image-only", imageKey: null }));
    await onSaved();
  }

  async function handleSave() {
    setShowErrors(true);
    if (submittingRef.current) return; // 🔴 同期ラッチで二重送信を防ぐ
    if (!destinationUrlOk) return;
    if (kind === "image" && (imageMissing || altMissing)) return; // ⚠ 保存ボタン自体も無効化している(下の disabled 参照)
    submittingRef.current = true;
    setStatus("saving");
    setError(null);
    const payload = {
      kind,
      content: {
        headline: headline.trim(),
        body: kind === "text" ? body.trim() : "",
        buttonLabel: buttonLabel.trim(),
        imageAlt: kind === "image" ? imageAlt.trim() : "",
      },
      destinationUrl,
    };

    if (isDraft) {
      const created = await postJson<{ id: string }>(`/popups/${popupId}/variants`, payload);
      if (!created.ok) {
        submittingRef.current = false;
        setStatus("idle");
        if (created.reason === "last_deliverable_variant") {
          setError(lastDeliverableMessage(created.message));
        } else {
          const field = created.field ? FIELD_LABELS[created.field] ?? created.field : null;
          setError(field ? `${field}を確認してください。` : "保存できませんでした。もう一度お試しください。");
        }
        return;
      }
      const id = created.data.id;
      if (kind === "image" && pendingFile) {
        setStatus("uploading");
        setUploadProgress(0);
        const uploaded = await uploadVariantImage(id, pendingFile, setUploadProgress);
        setUploadProgress(null);
        if (!uploaded.ok) {
          /*
            🔴 Codex 2巡目 Blocker: 「失敗したら消す」の結果を確かめずに握りつぶしていた
            (404・409・通信失敗を無視)。まずGETで実際の状態を確かめてから、消す/消さないを決める
            (`recoverFailedImageUpload`。詳細はファイル先頭のコメントと variantRecovery.ts 参照)。
          */
          const outcome = await recoverFailedImageUpload(id, {
            getVariant: (vid) => getJson<ApiVariant>(`/variants/${vid}`),
            deleteVariant: (vid) => deleteJson<unknown>(`/variants/${vid}`, { confirm: "delete" }),
          });
          submittingRef.current = false;
          setStatus("idle");
          if (outcome.kind === "recovered") {
            // 応答だけが失われていた。実際には成功していたので、保存済みとして同期する(成功の通知は出さない)
            clearPendingFile();
            applySavedVariant(outcome.variant);
            await onSaved({ silent: true });
            return;
          }
          if (outcome.kind === "reverted-to-draft") {
            // 画像が無いことを確認し、補償DELETEも成功した。まっさらな下書きに戻す
            setError(imageErrorMessage(uploaded.reason, uploaded.message));
            return;
          }
          // kept-without-image / unknown: 作ったIDを手放さない。保存済み・画像なしとして再同期する
          //   (これは「保存」経路——送った文字欄がサーバーに通ったので、文字欄・baselineごと揃えてよい)
          clearPendingFile();
          setSavedId(id);
          applyPatch(
            computeSyncPatch({
              kind: "save",
              server: {
                kind: payload.kind,
                headline: payload.content.headline,
                body: payload.content.body,
                buttonLabel: payload.content.buttonLabel,
                imageAlt: payload.content.imageAlt,
                destinationUrl: payload.destinationUrl,
                imageKey: null,
              },
            }),
          );
          setError(outcome.message);
          await onSaved({ silent: true });
          return;
        }
      }
      clearPendingFile();
      setSavedId(id);
      const synced = await syncFromServer(id);
      submittingRef.current = false;
      setStatus("idle");
      if (!synced) {
        setError("保存はできましたが、最新の状態を確認できませんでした。画面を再読み込みしてください。");
        await onSaved({ silent: true });
        return;
      }
      await onSaved();
      return;
    } else {
      const result = await putJson<unknown>(`/variants/${savedId}`, payload);
      if (!result.ok) {
        submittingRef.current = false;
        setStatus("idle");
        if (result.reason === "last_deliverable_variant") {
          setError(lastDeliverableMessage(result.message));
        } else {
          const field = result.field ? FIELD_LABELS[result.field] ?? result.field : null;
          setError(field ? `${field}を確認してください。` : "保存できませんでした。もう一度お試しください。");
        }
        return;
      }
      const synced = await syncFromServer(savedId as string);
      submittingRef.current = false;
      setStatus("idle");
      if (!synced) {
        setError("保存はできましたが、最新の状態を確認できませんでした。画面を再読み込みしてください。");
        await onSaved({ silent: true });
        return;
      }
    }

    await onSaved();
  }

  const saveDisabled = busy || (kind === "image" && (imageMissing || (showErrors && altMissing)));
  const imageUrl = imageKey !== null ? deliveryImageUrl(imageKey) : null;

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {isDraft ? (
            <div className="flex items-center gap-1 rounded-full border border-line p-0.5 text-xs font-medium">
              <button
                type="button"
                aria-pressed={kind === "text"}
                onClick={() => setKind("text")}
                className={`rounded-full px-2.5 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  kind === "text" ? "bg-ink text-paper" : "text-ink/60"
                }`}
              >
                テキスト
              </button>
              <button
                type="button"
                aria-pressed={kind === "image"}
                onClick={() => setKind("image")}
                className={`rounded-full px-2.5 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  kind === "image" ? "bg-ink text-paper" : "text-ink/60"
                }`}
              >
                画像
              </button>
            </div>
          ) : (
            <span className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink/60">
              {kind === "image" ? "画像" : "テキスト"}
            </span>
          )}
          {isDeliverable && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-soft px-2.5 py-1 text-xs font-semibold text-signal">
              <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden="true"></span>配信中
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm font-medium">
          {isDraft && onCancelDraft && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                clearPendingFile();
                onCancelDraft();
              }}
              className="text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40"
            >
              取り消す
            </button>
          )}
          {!isDraft && onArchived && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onArchived()}
              className="text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40"
            >
              アーカイブ
            </button>
          )}
          <button
            type="button"
            disabled={saveDisabled}
            onClick={handleSave}
            className="h-8 rounded-lg bg-ink px-3.5 text-xs font-semibold text-paper hover:bg-ink/90
                       disabled:cursor-not-allowed disabled:bg-ink/30
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {status === "saving" ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {error && <div className="mb-4"><FieldError id={`variant-error-${savedId ?? "draft"}`} message={error} /></div>}

      {kind === "text" ? (
        <div className="grid grid-cols-2 gap-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">見出し</label>
            <input
              type="text"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">ボタン文言</label>
            <input
              type="text"
              value={buttonLabel}
              onChange={(e) => setButtonLabel(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-ink">本文</label>
            <textarea
              rows={2}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-ink">遷移先URL</label>
            <input
              type="text"
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              disabled={busy}
              aria-invalid={showErrors && !destinationUrlOk}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 font-mono text-sm text-ink
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                         aria-[invalid=true]:border-danger"
            />
            {showErrors && !destinationUrlOk && (
              <FieldError id="dest-url-error-text" message="https:// から始まるURLを入力してください" />
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">画像</label>
            {status === "uploading" ? (
              <div className="flex items-center gap-4 rounded-lg border border-line bg-paper px-4 py-3">
                <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-md border border-line bg-surface opacity-40" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center justify-between font-mono text-xs text-ink/60">
                    <span>アップロード中…</span>
                    <span>{uploadProgress ?? 0}%</span>
                  </div>
                  {/*
                    🔴 CSP(管理画面)で style-src に unsafe-inline を許していないため、
                    幅を `style={{ width }}` で動かす実装は使えない(React の inline style は
                    CSP の style-src の対象。ブラウザの実装依存を避け、unsafe-inline 無しで
                    動的な見た目を変える手段として `<progress>` の value/max 属性を使う。
                    見た目は globals.css の `.upload-progress` で元のdiv実装に揃えている。
                    副次的に、ネイティブの role=progressbar + aria-valuenow が付く(a11yの改善)。
                  */}
                  <progress
                    className="upload-progress h-1.5 w-full"
                    value={uploadProgress ?? 0}
                    max={100}
                    aria-label="アップロードの進捗"
                  />
                </div>
              </div>
            ) : hasImage ? (
              <div className="flex items-center gap-4 rounded-lg border border-line bg-paper px-4 py-3">
                <div className="h-16 w-28 shrink-0 overflow-hidden rounded-md border border-line bg-surface">
                  {pendingPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 静的書き出しのため next/image の最適化サーバーが無い
                    <img src={pendingPreviewUrl} alt="" className="h-full w-full object-cover" />
                  ) : imageUrl !== null ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 同上。配信元は別オリジン(delivery Worker)
                    <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] text-ink/40">
                      配信元URL未設定
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {pendingPreviewUrl && (
                    <div className="mb-1 font-mono text-xs text-ink/60">保存時にアップロードされます</div>
                  )}
                  <div className="flex items-center gap-4 text-sm font-medium">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={selectFile}
                      className="text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      差し替え
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={pendingPreviewUrl ? clearPendingFile : removeImage}
                      className="text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      外す
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-4 rounded-lg border border-dashed border-line bg-paper px-4 py-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink/25">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="8.5" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M21 16l-5.5-5.5a2 2 0 00-2.8 0L4 19" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </div>
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={selectFile}
                    className="text-sm font-medium text-ink hover:underline disabled:cursor-not-allowed disabled:text-ink/40 disabled:no-underline
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    画像を選択
                  </button>
                  <div className="mt-1 font-mono text-xs text-ink/60">
                    PNG / JPEG / GIF / WebP・画像2MB・GIF3MBまで・長辺2,400pxまで
                  </div>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) handleFileChosen(file);
              }}
            />
          </div>

          <div>
            <label htmlFor={`alt-${savedId ?? "draft"}`} className="mb-1.5 block text-sm font-medium text-ink">
              画像の説明 {altRequired && <span className="text-danger">*</span>}{" "}
              <span className="font-normal text-ink/60">(スクリーンリーダー用{altRequired ? "" : "・任意"})</span>
            </label>
            <input
              id={`alt-${savedId ?? "draft"}`}
              type="text"
              value={imageAlt}
              onChange={(e) => setImageAlt(e.target.value)}
              disabled={busy}
              placeholder="例: 秋の新作キャンペーンの商品写真"
              aria-invalid={showErrors && altMissing}
              aria-describedby={showErrors && altMissing ? `alt-error-${savedId ?? "draft"}` : undefined}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/35
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                         aria-[invalid=true]:border-danger"
            />
            {showErrors && altMissing ? (
              <FieldError id={`alt-error-${savedId ?? "draft"}`} message="画像の説明を入力してください(ボタン文言が空のときは必須です)" />
            ) : (
              <div className="mt-1.5 text-xs text-ink/60">
                {altRequired
                  ? "ボタン文言が空のため必須です(画像だけのリンクでは、これが唯一の読み上げ内容になります)。"
                  : "ボタン文言があるので、ここは空でも読み上げられます。"}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">
                見出し <span className="font-normal text-ink/60">(任意)</span>
              </label>
              <input
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                disabled={busy}
                placeholder="未入力なら画像のみ表示"
                className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/35
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">
                ボタン文言 <span className="font-normal text-ink/60">(任意)</span>
              </label>
              <input
                type="text"
                value={buttonLabel}
                onChange={(e) => setButtonLabel(e.target.value)}
                disabled={busy}
                placeholder="空なら画像だけのバナーになります"
                className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/35
                           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
              <div className="mt-1.5 font-mono text-xs text-ink/60">
                表示: {buttonLabel.trim() === "" ? "画像のみ(タップで遷移)" : "画像+ボタン"}
              </div>
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">遷移先URL</label>
            <input
              type="text"
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              disabled={busy}
              placeholder="https://"
              aria-invalid={showErrors && !destinationUrlOk}
              className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 font-mono text-sm text-ink placeholder:text-ink/35
                         focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                         aria-[invalid=true]:border-danger"
            />
            {showErrors && !destinationUrlOk && (
              <FieldError id="dest-url-error-image" message="https:// から始まるURLを入力してください" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
