"use client";

/*
  パターン(バリアント)の編集カード(画面設計 §3-4・§7-2・§7-7)。
  `variant` が null = まだ作っていない空き枠(「+ パターンを追加」で生まれた下書き)。

  🔴 代替テキスト(画像の説明)はこのバージョンではサーバーに送らない。
    `src/admin/body.ts` の parseVariant は content の鍵を `headline`/`body`/`buttonLabel` の3つに
    厳密に固定している(`exactKeys`)ため、`imageAlt` を混ぜて送ると 400 になる。
    `imageAlt` のスキーマ追加は並行PR(画像ポップの配信)の範囲(画面設計 §7-5-2)。
    このPRでは入力欄とUI上の必須判定だけを用意し、値は保存しない(README・PR本文に明記)。
*/
import { useRef, useState } from "react";
import { postJson, putJson, uploadVariantImage, deleteJson } from "../_lib/api";
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
  const [status, setStatus] = useState<"idle" | "saving" | "uploading" | "removing-image">("idle");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isDraft = savedId === null;
  const destinationUrlOk = isValidHttpsUrl(destinationUrl);
  const altRequired = kind === "image" && buttonLabel.trim() === "";
  const altMissing = altRequired && imageAlt.trim() === "";
  const busy = status !== "idle";

  async function uploadFile(file: File) {
    let id = savedId;
    if (id === null) {
      if (!destinationUrlOk) {
        setShowErrors(true);
        setError("先に遷移先URLを入力してください。");
        return;
      }
      setStatus("saving");
      setError(null);
      const created = await postJson<{ id: string }>(`/popups/${popupId}/variants`, {
        kind,
        content: { headline: headline.trim(), body: "", buttonLabel: buttonLabel.trim() },
        destinationUrl,
      });
      if (!created.ok) {
        setStatus("idle");
        setError("保存できませんでした。もう一度お試しください。");
        return;
      }
      id = created.data.id;
      setSavedId(id);
    }
    setStatus("uploading");
    setUploadProgress(0);
    const result = await uploadVariantImage(id, file, setUploadProgress);
    setStatus("idle");
    setUploadProgress(null);
    if (!result.ok) {
      setError(imageErrorMessage(result.reason, result.message));
      return;
    }
    setError(null);
    await onSaved();
  }

  async function removeImage() {
    if (savedId === null) return;
    setStatus("removing-image");
    const result = await deleteJson<unknown>(`/variants/${savedId}/image`, {});
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
    if (!destinationUrlOk) return;
    if (kind === "image" && altMissing) return; // ⚠ UIだけの判定(上のコメント参照)。サーバーはまだ見ていない
    setStatus("saving");
    setError(null);
    const payload = {
      kind,
      content: { headline: headline.trim(), body: kind === "text" ? body.trim() : "", buttonLabel: buttonLabel.trim() },
      destinationUrl,
    };
    const result = isDraft
      ? await postJson<{ id: string }>(`/popups/${popupId}/variants`, payload)
      : await putJson<unknown>(`/variants/${savedId}`, payload);
    setStatus("idle");
    if (!result.ok) {
      const field = result.field ? FIELD_LABELS[result.field] ?? result.field : null;
      setError(field ? `${field}を確認してください。` : "保存できませんでした。もう一度お試しください。");
      return;
    }
    if (isDraft && "data" in result) setSavedId((result.data as { id: string }).id);
    await onSaved();
  }

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
              onClick={onCancelDraft}
              className="text-ink/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
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
            disabled={busy}
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
            ) : imageKey !== null ? (
              <div className="flex items-center gap-4 rounded-lg border border-line bg-paper px-4 py-3">
                <div className="h-16 w-28 shrink-0 overflow-hidden rounded-md border border-line bg-surface" />
                <div className="min-w-0 flex-1">
                  <div className="mt-1.5 flex items-center gap-4 text-sm font-medium">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => fileInputRef.current?.click()}
                      className="text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      差し替え
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={removeImage}
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
                    disabled={busy || (isDraft && !destinationUrlOk)}
                    onClick={() => fileInputRef.current?.click()}
                    className="text-sm font-medium text-ink hover:underline disabled:cursor-not-allowed disabled:text-ink/40 disabled:no-underline
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    画像を選択
                  </button>
                  <div className="mt-1 font-mono text-xs text-ink/60">
                    PNG / JPEG / GIF / WebP・画像2MB・GIF3MBまで・長辺2,400pxまで
                  </div>
                  {isDraft && !destinationUrlOk && (
                    <div className="mt-1 text-xs text-ink/60">先に遷移先URLを入力してください</div>
                  )}
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
                if (file) uploadFile(file);
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
