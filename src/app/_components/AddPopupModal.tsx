"use client";

import { useId, useState } from "react";
import { Modal } from "./Modal";
import { FieldError } from "./ErrorBanner";

export function AddPopupModal({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (name: string) => Promise<string | null>;
}) {
  const titleId = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("名前を入力してください");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onCreate(name.trim());
    setSubmitting(false);
    if (result !== null) setError(result);
  }

  return (
    <Modal titleId={titleId} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <h2 id={titleId} className="mb-5 text-base font-semibold text-ink">
          ポップを追加
        </h2>
        {error && <FieldError id="popup-form-error" message={error} />}
        <div className="mb-6 mt-3">
          <label htmlFor="popup-name-new" className="mb-1.5 block text-sm font-medium text-ink">
            名前
          </label>
          <input
            id="popup-name-new"
            type="text"
            placeholder="例: 秋の入会キャンペーン"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink placeholder:text-ink/30
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-lg px-4 text-sm font-medium text-ink/60 hover:bg-paper
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
            {submitting ? "作成中…" : "作成"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
