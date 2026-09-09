/*
  ローダ(`t.js`)と本体(`adpop.js`)をつなぐ**唯一のグローバル**。MIT(このディレクトリのみ)。

  🔴 **`window` に生やすのは、この鍵1つだけ**(要件書 §5-2)。
    プロトタイプの拡張も、他の鍵も、1つも足さない。**そのことは検査で固定する。**
  🔴 **本体はローダの持ち物を「写し」で持たない** —— イベントの送信も設定も、
    ローダが `bridge` に置いたものだけを使う。写しを作ると、片方だけ直した日にずれる。
*/

/** ⚠ 埋め込み先の LP に既に在る名前とぶつからない形にする。 */
export const NAMESPACE = "__adpopExitPopup";

/*
  ⚠ **配信ホストは書かない。パスだけ。** ホストはローダが自分の `src` から取る(要件書 §9 の実装制約)。
  🔴 `RUNTIME_PATH` は `scripts/bundle-size.mjs` の `publicOut` と**同じ場所を指していないと、
    本体が 404 になって何も出ない**(しかも fail-closed なので静かに何も起きない)。
    → **写しなので `tests/embed-safety.test.ts` が機械で突き合わせる。**
  ⚠ このモジュールに**副作用のあるものを置かない** —— 検査が「起動させずに定数だけ読む」ために import する。
*/
export const RUNTIME_PATH = "/embed/adpop.js";
export const CONFIG_PATH = "/api/v1/config";
export const EVENTS_PATH = "/api/v1/events";

export type TriggerKind = "back" | "scroll" | "idle" | "dwell" | "visibility" | "exit_intent";

export type EventKind = "fire" | "suppressed" | "impression" | "click" | "close";

export type CloseReason = "button" | "backdrop" | "esc";

export type VariantContent = {
  headline?: unknown;
  body?: unknown;
  buttonLabel?: unknown;
  imageKey?: unknown;
};

export type Variant = {
  key: string;
  kind: string;
  weight: number;
  content: VariantContent;
  destinationUrl: string;
};

export type PopupConfig = {
  key: string;
  minDisplayDelaySeconds: number;
  frequency: { suppressDays: number; sessionImpressions: number; postConversionDays: number };
  triggers: Array<{ kind: TriggerKind; threshold: number | null }>;
  variants: Variant[];
};

export type SiteConfig = { v: number; popup: PopupConfig };

/** 投入エンドポイントへ送る形。⚠ **正は 0003 の `adpop_record_event`**(ここは呼ぶ側の写し)。 */
export type EventPayload = {
  kind: EventKind;
  popupKey: string;
  variantKey?: string;
  triggerKind?: TriggerKind;
  impressionId?: string;
  visitorHash?: string;
  device: "mobile" | "desktop";
  closeReason?: CloseReason;
  pageUrl?: string;
};

/** 本体への注文。**本体は DOM も設定も読み直さない**(読み直すと、読む場所が2つになる)。 */
export type RenderRequest = {
  popupKey: string;
  variant: Variant;
  triggerKind: TriggerKind;
  visitorHash: string;
  device: "mobile" | "desktop";
  pageUrl: string;
  impressionId: string;
};

export type Bridge = {
  version: string;
  /** ローダが埋める。本体はこれだけを見る。 */
  request?: RenderRequest;
  /** ローダが持つ送信口。**本体は自分では送らない。** */
  send?: (event: EventPayload) => void;
  /** 本体が読み込み時に埋める。ローダは注文を置いてからこれを呼ぶ(順番が逆でも動く)。 */
  render?: () => void;
  /** 1ページ1回だけ出す(要件書 §4-2)。 */
  shown?: boolean;
  /** 表示が確定したときにローダへ知らせる(頻度制御の記録は**ローダが持つ**)。 */
  onShown?: () => void;
};

type GlobalWithBridge = Record<string, unknown>;

export function readBridge(win: unknown): Bridge | undefined {
  const value = (win as GlobalWithBridge)[NAMESPACE];
  return typeof value === "object" && value !== null ? (value as Bridge) : undefined;
}

export function writeBridge(win: unknown, bridge: Bridge): void {
  (win as GlobalWithBridge)[NAMESPACE] = bridge;
}
