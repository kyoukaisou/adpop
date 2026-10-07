"use client";

/*
  「サイトを追加」「サイトを編集」モーダル(画面設計 §3-2 / レビュー指摘: 編集導線の欠落)。
  名前+許可ドメイン(チップ形式で複数追加)。追加・編集は同じ部品を使う(承認済み見本の部品を増やさない)。
*/
import { useId, useRef, useState } from "react";
import { Modal } from "./Modal";
import { FieldError } from "./ErrorBanner";
import { TAP_TARGET_44_ICON } from "../_lib/a11y";

const MAX_ORIGINS = 20;

/** サーバー側(src/lib/data/shapes.ts の isOrigin)と同じ形を想定した事前チェック。https のみ。 */
function looksLikeOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function SiteFormModal({
  title,
  submitLabel,
  submittingLabel,
  initialName,
  initialOrigins,
  onCancel,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  submittingLabel: string;
  initialName: string;
  initialOrigins: string[];
  onCancel: () => void;
  onSubmit: (input: { name: string; allowedOrigins: string[] }) => Promise<string | null>;
}) {
  const titleId = useId();
  const [name, setName] = useState(initialName);
  const [origins, setOrigins] = useState<string[]>(initialOrigins);
  const [draft, setDraft] = useState("");
  const [originError, setOriginError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function addOrigin() {
    const value = draft.trim();
    if (value === "") return;
    if (!looksLikeOrigin(value)) {
      setOriginError("https:// から始まる、パスの無いURLを入力してください(例: https://example.com)");
      return;
    }
    if (origins.includes(value)) {
      setOriginError("すでに追加されています");
      return;
    }
    if (origins.length >= MAX_ORIGINS) {
      setOriginError(`許可ドメインは${MAX_ORIGINS}件までです`);
      return;
    }
    setOrigins([...origins, value]);
    setDraft("");
    setOriginError(null);
  }

  function removeOrigin(origin: string) {
    setOrigins(origins.filter((o) => o !== origin));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return; // 🔴 二重送信防止(同期ラッチ)
    if (name.trim() === "") {
      setFormError("名前を入力してください");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);
    const error = await onSubmit({ name: name.trim(), allowedOrigins: origins });
    submittingRef.current = false;
    setSubmitting(false);
    if (error !== null) setFormError(error);
  }

  return (
    <Modal titleId={titleId} onClose={submitting ? () => {} : onCancel}>
      <form onSubmit={handleSubmit}>
        <h2 id={titleId} className="mb-5 text-base font-semibold text-ink">
          {title}
        </h2>

        {formError && <FieldError id="site-form-error" message={formError} />}

        <div className="mb-5 mt-3">
          <label htmlFor="site-name" className="mb-1.5 block text-sm font-medium text-ink">
            名前
          </label>
          <input
            id="site-name"
            type="text"
            placeholder="例: 商品LP"
            value={name}
            disabled={submitting}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/30
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
        </div>

        <div className="mb-2">
          <span className="mb-1.5 block text-sm font-medium text-ink">許可ドメイン</span>
          {origins.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {origins.map((origin) => (
                <span
                  key={origin}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-xs text-ink/70"
                >
                  {origin}
                  <button
                    type="button"
                    aria-label={`${origin} を削除`}
                    disabled={submitting}
                    onClick={() => removeOrigin(origin)}
                    className={`text-ink/60 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${TAP_TARGET_44_ICON}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="mb-1 flex gap-2">
          <input
            type="text"
            placeholder="https://example.com"
            aria-label="許可ドメインを追加"
            value={draft}
            disabled={submitting}
            onChange={(e) => {
              setDraft(e.target.value);
              setOriginError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOrigin();
              }
            }}
            className="h-10 flex-1 rounded-lg border border-line bg-surface px-3.5 font-mono text-xs text-ink placeholder:text-ink/30
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
          <button
            type="button"
            disabled={submitting}
            onClick={addOrigin}
            className="h-10 shrink-0 rounded-lg border border-line px-3.5 text-sm font-medium text-ink hover:bg-paper
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            追加
          </button>
        </div>
        {originError && <FieldError id="origin-error" message={originError} />}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="h-10 rounded-lg px-4 text-sm font-medium text-ink/60 hover:bg-paper
                       disabled:cursor-not-allowed disabled:opacity-50
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            キャンセル
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="h-10 rounded-lg bg-ink px-4 text-sm font-semibold text-paper hover:bg-ink/90
                       disabled:cursor-not-allowed disabled:bg-ink/60
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {submitting ? submittingLabel : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AddSiteModal({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: { name: string; allowedOrigins: string[] }) => Promise<string | null>;
}) {
  return (
    <SiteFormModal
      title="サイトを追加"
      submitLabel="作成"
      submittingLabel="作成中…"
      initialName=""
      initialOrigins={[]}
      onCancel={onCancel}
      onSubmit={onCreate}
    />
  );
}

export function EditSiteModal({
  initialName,
  initialOrigins,
  onCancel,
  onSave,
}: {
  initialName: string;
  initialOrigins: string[];
  onCancel: () => void;
  onSave: (input: { name: string; allowedOrigins: string[] }) => Promise<string | null>;
}) {
  return (
    <SiteFormModal
      title="サイトを編集"
      submitLabel="保存"
      submittingLabel="保存中…"
      initialName={initialName}
      initialOrigins={initialOrigins}
      onCancel={onCancel}
      onSubmit={onSave}
    />
  );
}
