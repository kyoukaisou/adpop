/*
  通信失敗のバナー(画面設計 §7-4)。原因の操作の近くに出す。謝辞・内訳・仕組みの説明は書かない。
  🔴 P-011(fail-open): 失敗は失敗として表示する。成功に見せない。
*/
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mb-6 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
      <svg className="mt-0.5 h-4 w-4 shrink-0 text-danger" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 6.5v4M10 13.2v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <div className="flex-1 text-sm text-ink">
        <div className="font-medium">{message}</div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-8 shrink-0 rounded-lg border border-danger/40 px-3 text-xs font-semibold text-danger hover:bg-danger/10
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
        >
          もう一度保存
        </button>
      )}
    </div>
  );
}

/** フィールド単位のエラー(赤枠+短文)。画面設計 §7-4。 */
export function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <div id={id} className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-danger">
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 6.5v4M10 13.2v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      {message}
    </div>
  );
}
