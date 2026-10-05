import type { ApiPopupStatus } from "../_lib/types";

/** 「稼働中」だけが彩色(signal)。他はすべてグレースケール(画面設計 §0 シグネチャ)。 */
export function PopupStatusChip({ status }: { status: ApiPopupStatus }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-soft px-2.5 py-1 text-xs font-semibold text-signal">
        <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden="true"></span>
        稼働中
      </span>
    );
  }
  return <span className="rounded-full border border-line bg-paper px-2.5 py-1 text-xs font-medium text-ink/60">停止</span>;
}
