"use client";

/*
  完全に削除の確認(画面設計 §3-3・§8-2-2・§8-7)。
  🔴 「数字も一緒に消えます。元に戻せません。」を明示してから danger 色のボタンでのみ実行できる。
  🔴 LINEハーネス比較 D-327 A採用: 実行ボタンは2秒間押せない(1→0でラベルが変わる)。
  🔴 「キャンセル」はカウントダウン中も常時有効(無効化するのは danger の実行ボタンだけ。§8-7 H3)。
*/
import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";

const COUNTDOWN_SECONDS = 2;

export function ConfirmDeleteDialog({
  name,
  stats,
  onCancel,
  onConfirm,
}: {
  name: string;
  /** 「表示◯件・クリック◯件・閉じた◯件」の文言。数字が取得できない場合は null。 */
  stats: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const disabled = remaining > 0;

  return (
    <Modal titleId={titleId} descriptionId={descId} onClose={onCancel}>
      <h2 id={titleId} className="mb-3 text-base font-semibold text-ink">
        「{name}」を完全に削除しますか
      </h2>
      <p id={descId} className="mb-6 text-sm leading-relaxed text-ink/70">
        {stats !== null
          ? `${stats} の数字も一緒に消えます。元に戻せません。`
          : "この操作は元に戻せません。"}
      </p>
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
          type="button"
          disabled={disabled}
          onClick={onConfirm}
          className="h-10 rounded-lg bg-danger px-4 text-sm font-semibold text-paper hover:bg-danger/90
                     disabled:cursor-not-allowed disabled:bg-danger/40
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
        >
          {disabled ? `完全に削除する (${remaining})` : "完全に削除する"}
        </button>
      </div>
    </Modal>
  );
}
