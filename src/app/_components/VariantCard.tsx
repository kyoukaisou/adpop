"use client";

/*
  パターン(バリアント)の編集カード(画面設計 §3-4・§7-2・§7-7)。
  `variant` が null = まだ作っていない空き枠(「+ パターンを追加」で生まれた下書き)。

  🔴 代替テキスト(画像の説明)はこのバージョンではサーバーに送らない。
    `src/admin/body.ts` の parseVariant は content の鍵を `headline`/`body`/`buttonLabel` の3つに
    厳密に固定している(`exactKeys`)ため、`imageAlt` を混ぜて送ると 400 になる。
    `imageAlt` のスキーマ追加は並行PR(画像ポップの配信)の範囲(画面設計 §7-5-2)。
    このPRでは入力欄とUI上の必須判定だけを用意し、値は保存しない(README・PR本文に明記)。

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
*/
import { useEffect, useRef, useState } from "react";
import { deleteJson, getJson, postJson, putJson, uploadVariantImage } from "../_lib/api";
import { deliveryImageUrl } from "../_lib/delivery";
import { imageErrorMessage } from "../_lib/imageErrors";
import {
  ApiVariant,
  ApiVariantKind,
  variantBody,
  variantButtonLabel,
  variantHeadline,
  variantImageKey,
} from "../_lib/types";
import { FieldError } from "../_components/ErrorBanner";

const FIELD_LABELS: Record<string, string> = {
  headline: "見出し",
  body: "本文",
  buttonLabel: "ボタン文言",
  destinationUrl: "遷移先URL",
  kind: "種類",
  content: "入力内容",
};

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
}: {
  variant: ApiVariant | null;
  isDeliverable: boolean;
  popupId: string;
  onSaved: () => Promise<void> | void;
  onArchived: (() => Promise<void> | void) | null;
  onCancelDraft: (() => void) | null;
}) {
  const [kind, setKind] = useState<ApiVariantKind>(variant?.kind === "image" ? "image" : "text");
  const [headline, setHeadline] = useState(variant ? variantHeadline(variant) : "");
  const [body, setBody] = useState(variant ? variantBody(variant) : "");
  const [buttonLabel, setButtonLabel] = useState(variant ? variantButtonLabel(variant) : "");
  const [destinationUrl, setDestinationUrl] = useState(variant?.destinationUrl ?? "");
  const [imageAlt, setImageAlt] = useState(""); // ⚠ ローカルのみ。サーバーには送らない(上のコメント参照)
  const [showErrors, setShowErrors] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(variant?.id ?? null);
  const [imageKey, setImageKey] = useState<string | null>(variant ? variantImageKey(variant) : null);
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

  // オブジェクトURLの後始末
  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
  }, [pendingPreviewUrl]);

  /** 保存・アップロード・画像削除の後、サーバーが実際に持っている値で画面を置き換える(P-012対応)。 */
  async function syncFromServer(id: string) {
    const result = await getJson<ApiVariant>(`/variants/${id}`);
    if (!result.ok) return; // ⚠ 直後の一覧再読み込み(onSaved)でも間接的に反映されるので、ここは黙って諦める
    const v = result.data;
    setKind(v.kind === "image" ? "image" : "text");
    setHeadline(variantHeadline(v));
    setBody(variantBody(v));
    setButtonLabel(variantButtonLabel(v));
    setDestinationUrl(v.destinationUrl);
    setImageKey(variantImageKey(v));
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
    await syncFromServer(id);
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
      setError("画像を外せませんでした。もう一度お試しください。");
      return;
    }
    setImageKey(null);
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
      content: { headline: headline.trim(), body: kind === "text" ? body.trim() : "", buttonLabel: buttonLabel.trim() },
      destinationUrl,
    };

    if (isDraft) {
      const created = await postJson<{ id: string }>(`/popups/${popupId}/variants`, payload);
      if (!created.ok) {
        submittingRef.current = false;
        setStatus("idle");
        const field = created.field ? FIELD_LABELS[created.field] ?? created.field : null;
        setError(field ? `${field}を確認してください。` : "保存できませんでした。もう一度お試しください。");
        return;
      }
      const id = created.data.id;
      if (kind === "image" && pendingFile) {
        setStatus("uploading");
        setUploadProgress(0);
        const uploaded = await uploadVariantImage(id, pendingFile, setUploadProgress);
        setUploadProgress(null);
        if (!uploaded.ok) {
          // 🔴 Blocker 2: アップロードが失敗したら、作ったパターンを消す(中身の無いパターンを残さない)
          await deleteJson<unknown>(`/variants/${id}`, { confirm: "delete" }).catch(() => {});
          submittingRef.current = false;
          setStatus("idle");
          setError(imageErrorMessage(uploaded.reason, uploaded.message));
          return;
        }
      }
      clearPendingFile();
      setSavedId(id);
      await syncFromServer(id);
    } else {
      const result = await putJson<unknown>(`/variants/${savedId}`, payload);
      if (!result.ok) {
        submittingRef.current = false;
        setStatus("idle");
        const field = result.field ? FIELD_LABELS[result.field] ?? result.field : null;
        setError(field ? `${field}を確認してください。` : "保存できませんでした。もう一度お試しください。");
        return;
      }
      await syncFromServer(savedId as string);
    }

    submittingRef.current = false;
    setStatus("idle");
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
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-ink" style={{ width: `${uploadProgress ?? 0}%` }} />
                  </div>
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
