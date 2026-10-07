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

/**
 * 埋め込みが実装しているトリガ。⚠ ここに無い kind はサーバーが返しても**黙って無視する**。
 * ⚠ 管理画面(AGPL 側)も「いま効くトリガ」だけを ON/OFF させるためにこれを読む(向きは server → embed なので可)。
 *   **理由の記録はローダ(`loader.ts` の再輸出の箇所)に置いてある。**
 */
export const IMPLEMENTED_TRIGGERS: readonly TriggerKind[] = ["exit_intent"];

/**
 * 本体が描く文字数の上限(UTF-16 の長さ)。**これを超えた分は描かれない**(本体が切る)。
 * ⚠ 管理画面の API も同じ値で断る —— 保存できた文字が画面で切れる、を作らないため。
 * 🔴 `imageAlt`(画像の説明)は `headline` と同じ上限にした —— 見出しが無い画像バナーでは
 *   ダイアログの `aria-label` にもなる(同じ役割を担うため、同じ上限で揃える)。
 */
export const TEXT_LIMITS = { headline: 300, body: 600, buttonLabel: 60, imageAlt: 300 } as const;

export type EventKind = "fire" | "suppressed" | "impression" | "click" | "close";

export type CloseReason = "button" | "backdrop" | "esc";

export type VariantContent = {
  headline?: unknown;
  body?: unknown;
  buttonLabel?: unknown;
  imageKey?: unknown;
  imageAlt?: unknown;
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
  /**
   * 🔴 **画像型(§4-3 B)の画像 URL を組み立てるための配信ホスト**(ローダが自分の `<script src>` の
   *   origin から読んだもの。§9 の実装制約でコードに直書きしない、の続き)。
   * ⚠ テキスト型では使わない。**サーバーの応答から来る値ではない**(ローダが自分で読んだタグの `src` の origin)。
   */
  deliveryOrigin?: string;
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
  /**
   * 🔴 **描画中かどうか(レビュー指摘)**。`startRuntime()` のローカル変数だと、
   *   画像の読み込みを待っている間に本体がもう一度読み込まれたとき(= 2つ目の `startRuntime()`)が
   *   **別の変数**を見てしまい、二重に描いてしまう。**排他は `bridge`(共有物)の側に持たせる**。
   */
  drawing?: boolean;
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
