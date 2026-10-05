"use client";

/*
  完全に削除の確認(画面設計 §3-3・§8-2-2・§8-7)。
  🔴 「数字も一緒に消えます。元に戻せません。」を明示してから danger 色のボタンでのみ実行できる。
  🔴 LINEハーネス比較 D-327 A採用: 実行ボタンは2秒間押せない(1→0でラベルが変わる)。
  🔴 「キャンセル」はカウントダウン中も常時有効(無効化するのは danger の実行ボタンだけ。§8-7 H3)。
  🔴 Codex 1巡目 Blocker 1: 2秒経過後の二重送信を防ぐ。クリックした時点で `submittingRef`(ref=同期)を
    立ててから state を更新し、`onConfirm` の Promise が終わるまでボタンを無効化する。
    送信中は「キャンセル」も押せない(途中で親の状態と食い違わせないため)。
*/
import { useEffect, useId, useRef, useState } from "react";
import { Modal } from "./Modal";

const COUNTDOWN_SECONDS = 2;

export function ConfirmDeleteDialog({
  name,
  stats,
  onCancel,
  onConfirm,
}: {
  name: string;
  /**
   * 「表示◯件・クリック◯件・閉じた◯件」の文言。
   * 🔴 Codex r1 Should fix: 「数字が取得できない」場合は、呼び出し側(`stats.ts` の
   *   `deleteConfirmStatsText`)が各項目を「—」にした文字列を返す(数字が消えることを伝える、
   *   という確認の目的自体を消さないため)。`null` は「この削除対象にそもそも数字の概念が無い」
   *   ときだけに使う(現状の呼び出し元=ポップ削除には無い。将来、数字を持たない削除対象の
   *   ダイアログにこの部品を使い回すときのための枠)。
   */
  stats: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const titleId = useId();
  const descId = useId();
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const countdownActive = remaining > 0;

  async function handleConfirmClick() {
    // 🔴 同期的なラッチ(ref)。state の反映を待たず、この関数の最初の行で二重実行を止める
    if (submittingRef.current || countdownActive) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal titleId={titleId} descriptionId={descId} onClose={submitting ? () => {} : onCancel}>
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
          disabled={submitting}
          onClick={onCancel}
          className="h-10 rounded-lg px-4 text-sm font-medium text-ink/60 hover:bg-paper
                     disabled:cursor-not-allowed disabled:opacity-50
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          キャンセル
        </button>
        <button
          type="button"
          disabled={countdownActive || submitting}
          onClick={handleConfirmClick}
          className="h-10 rounded-lg bg-danger px-4 text-sm font-semibold text-paper hover:bg-danger/90
                     disabled:cursor-not-allowed disabled:bg-danger/40
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
        >
          {countdownActive ? `完全に削除する (${remaining})` : submitting ? "削除中…" : "完全に削除する"}
        </button>
      </div>
    </Modal>
  );
}
