/*
  0件の状態(画面設計 §7-3)。既存の破線パネル語彙を再利用し、大きく1つのCTAを置く。
*/
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-line bg-surface px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-paper text-ink/40">{icon}</div>
      <div>
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="mt-1 text-sm text-ink/60">{description}</div>
      </div>
      {action}
    </div>
  );
}

export const SiteIcon = (
  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3 9h18" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export const PopupIcon = (
  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 9h8M8 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
