"use client";

/*
  ページを離れるときの確認(ポップ編集・設計上の要件)。パンくず・ログアウトの2経路で共通に使う。
  🔴 「確認のダイアログが要るなら、既存の確認ダイアログの部品を使う」(発注)——`window.confirm` の
    ような素のブラウザダイアログではなく、`ConfirmDeleteDialog` と同じ `Modal`(フォーカストラップ・
    Escで閉じる・開く前のフォーカス位置への復帰)を使う。
  ⚠ ブラウザを閉じる・再読み込み(`beforeunload`)は、この仕組みでは止められない
    (カスタムダイアログの応答を待たずOSレベルで閉じられるため)。そちらはブラウザ自身の確認
    (`unsavedChanges.ts` の `useBeforeUnloadGuard`)を使う——文言を出せないのはブラウザの仕様。

  🔴 レビュー指摘: 「未保存の入力がある」のと「保存・アップロード・削除が進行中」は別の
    理由なので、文言も分ける。進行中に離脱すると送信中のリクエストが中断されるため、
    「保存していない」より強く注意を促す短い文言にする。
*/
import { useId } from "react";
import { Modal } from "./Modal";

const COPY: Record<"unsaved" | "busy", { title: string; body: string }> = {
  unsaved: { title: "保存していない変更があります", body: "移動しますか。入力した内容は失われます。" },
  busy: { title: "保存中です", body: "移動すると中断されます。" },
};

export function UnsavedChangesDialog({
  reason,
  onCancel,
  onConfirm,
}: {
  reason: "unsaved" | "busy";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const { title, body } = COPY[reason];

  return (
    <Modal titleId={titleId} descriptionId={descId} onClose={onCancel}>
      <h2 id={titleId} className="mb-3 text-base font-semibold text-ink">
        {title}
      </h2>
      <p id={descId} className="mb-6 text-sm leading-relaxed text-ink/70">
        {body}
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
          onClick={onConfirm}
          className="h-10 rounded-lg bg-ink px-4 text-sm font-semibold text-paper hover:bg-ink/90
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          移動する
        </button>
      </div>
    </Modal>
  );
}
