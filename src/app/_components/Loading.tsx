/*
  読み込み中の表現(画面設計 §8-2-1 = LINEハーネス比較 A採用)。
  スピナー(彩色なし・ink/60)+「読み込み中」のテキストをインラインで出す。スケルトンは作らない。
*/
export function Loading({ label = "読み込み中" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-ink/60" role="status">
      <svg className="h-4 w-4 animate-spin text-ink/60" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.3" />
        <path d="M17.5 10a7.5 7.5 0 00-7.5-7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {label}
    </div>
  );
}
