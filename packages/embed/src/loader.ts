/*
  ADPOP のローダ(`t.js`)—— **全訪問者に配る側**。MIT(このディレクトリのみ)。

  やること(要件書 §4-1 の2段構え):
    ①タグから サイトキー と配信ホストを読む ②設定を取りに行く ③トリガを仕掛ける
    ④発火したら `fire` を送り、頻度制御を見て ⑤出すと決まってから**本体を取りに行く**
  ⚠ 出ないまま終わる訪問者には、**本体を1バイトも配らない**(2段構えの目的)。

  🔴 **埋め込み先の LP を1ミリも壊さない**(要件書 §5-2)。この4つは検査で固定してある:
    ① **描画を止めない** —— `document.write` も同期 XHR も使わない。タグは `async`。
    ② **エラーを外に漏らさない** —— 全部を try/catch で囲み、**失敗したら何もしない**。
    ③ **グローバルを汚さない** —— `window` に生やすのは名前空間1つだけ。
    ④ **配信が落ちても LP は無傷** —— fail-closed(ポップが出ないだけ)。
  ⚠ ②の代償: **こちら側の失敗が誰にも見えない**。管理画面へ届ける仕組みは PR3
    (要件書 §5-2 の「握り潰して誰も見ない」への対処)。**いまは届いていない**と README に書いた。

  🔴 **PR2 で実装したトリガは ①戻る と ⑥exit intent の2つだけ**(要件書 §4-2)。
    残りの4つ(スクロール率・無操作・滞在時間・タブ切替)は **PR4**。
    ⚠ サーバーは**有効なトリガを6種すべて返す**ので、ここは**知らない kind を黙って無視する**
      (= 管理画面で ON にしても PR4 までは何も起きない。README に書いた)。
*/
import {
  CONFIG_PATH,
  EVENTS_PATH,
  NAMESPACE,
  readBridge,
  RUNTIME_PATH,
  writeBridge,
  type Bridge,
  type EventPayload,
  type PopupConfig,
  type RenderRequest,
  type SiteConfig,
  type TriggerKind,
  type Variant,
} from "./bridge";
import { isSafeDestination, suppressionReason, type VisitorState } from "./frequency";

export const ADPOP_LOADER_VERSION = "0.1.0";

/** タグに書く属性。⚠ 要件書 §4-1 は「属性名は実装時に確定」。**`data-site` より衝突しにくい形**にした。 */
export const SITE_ATTRIBUTE = "data-adpop-site";

/** プレビュー用の強制表示(要件書 §4-4)。⚠ **この表示は数値に数えない**。 */
export const PREVIEW_PARAM = "adpop_preview";

// ⚠ パスは `./bridge`(副作用の無いモジュール)が持つ —— 検査が起動させずに読めるように。

/** PR2 で実装しているトリガ。⚠ ここに無い kind はサーバーが返しても無視する。 */
const IMPLEMENTED_TRIGGERS: TriggerKind[] = ["back", "exit_intent"];

type Win = Window & typeof globalThis;

/** 何があっても外へ投げない(要件書 §5-2 の②)。 */
function quiet(run: () => void): void {
  try {
    run();
  } catch {
    /* 🔴 ここで握るのが仕事。LP のスクリプトを1つも止めない。 */
  }
}

function hex(length: number, win: Win): string {
  let out = "";
  try {
    const source = win.crypto;
    if (source && typeof source.getRandomValues === "function") {
      const bytes = new Uint8Array(Math.ceil(length / 2));
      source.getRandomValues(bytes);
      for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] + 0x100).toString(16).slice(1);
      return out.slice(0, length);
    }
  } catch {
    /* 下の fallback へ */
  }
  /*
    ⚠ **暗号的ではない fallback**。ここで作るのは「頻度制御のための匿名ID」だけで、
      秘密でも認証でもない(要件書 §5-4)。⚠ 秘密の生成にこの関数を使わない。
  */
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, length);
}

function uuid(win: Win): string {
  try {
    const source = win.crypto as Crypto & { randomUUID?: () => string };
    if (source && typeof source.randomUUID === "function") return source.randomUUID();
  } catch {
    /* 下の fallback へ */
  }
  const h = hex(32, win);
  // v4 の形に整える(値の質は上の fallback と同じ = 暗号的ではない)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * 端末を**2値**に落とす(要件書 §5-4。生の User-Agent は使わない・保存しない)。
 *
 * 🔴🔴 **`"ontouchstart" in window` を使わない**(2026-09-09 実測で誤りと判明)。
 *   ・jsdom では **true**(Touch Events の IDL 属性を持っている)
 *   ・**デスクトップの Chrome でも true**(ハードウェアに関係なく Touch Events を実装しているため)
 *   → これを touch の判定に使うと、**PC を「スマホ」と数え**、
 *     ⑥exit intent が**PC で1度も登録されない**(= 既定 ON のトリガが黙って死ぬ)。
 *   ⚠ しかも **fail-closed なので誰も気づかない**(ポップが出なくなるだけ)。
 *
 * ✅ 見るのは2つだけ:
 *   ① `(pointer: coarse)` …… 主な入力装置が指かどうか。**これが本命**
 *   ② `navigator.maxTouchPoints` …… `matchMedia` が無い環境の控え。
 *      ⚠ PC の Chrome でも **0** になる(`ontouchstart` と違って**ハードウェアを見る**)
 */
function isTouchDevice(win: Win): boolean {
  try {
    if (typeof win.matchMedia === "function") return win.matchMedia("(pointer: coarse)").matches;
  } catch {
    /* 下の fallback へ */
  }
  try {
    const points = win.navigator?.maxTouchPoints;
    return typeof points === "number" && points > 0;
  } catch {
    return false;
  }
}

function readState(win: Win, key: string): VisitorState | null {
  try {
    const raw = win.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as VisitorState) : null;
  } catch {
    // ⚠ 読めない = 抑制が効かない(要件書 §4-4 の既知の限界)。**出しすぎる側**に倒す。
    return null;
  }
}

function writeState(win: Win, key: string, state: VisitorState): void {
  try {
    win.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* 保存できなくても表示は続ける */
  }
}

function sessionCount(win: Win, key: string): number {
  try {
    const raw = win.sessionStorage.getItem(key);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function bumpSession(win: Win, key: string): void {
  try {
    win.sessionStorage.setItem(key, String(sessionCount(win, key) + 1));
  } catch {
    /* 保存できなくても表示は続ける */
  }
}

/**
 * 自分を読み込んだ `<script>` から、**サイトキー**と**配信ホスト**を読む。
 * 🔴 **配信ホストをコードに直書きしない**(要件書 §9 の実装制約。ドメインは未取得で、後で変わる)。
 *   → **自分の `src` の origin** を使う。タグを貼り替えれば、それだけで配信先が変わる。
 */
export function readTag(doc: Document): { siteKey: string; deliveryOrigin: string } | null {
  const current = doc.currentScript as HTMLScriptElement | null;
  const script =
    current && current.getAttribute(SITE_ATTRIBUTE)
      ? current
      : (doc.querySelector(`script[${SITE_ATTRIBUTE}]`) as HTMLScriptElement | null);
  if (!script) return null;
  const siteKey = script.getAttribute(SITE_ATTRIBUTE);
  if (!siteKey) return null;
  try {
    // ⚠ `script.src` は解決済みの絶対 URL。取れない(インライン)なら諦める = fail-closed
    const origin = new URL(script.src).origin;
    if (!origin || origin === "null") return null;
    return { siteKey, deliveryOrigin: origin };
  } catch {
    return null;
  }
}

/** 応答が「設定の形」をしているか。⚠ **形が違えば何も出さない**(fail-closed)。 */
export function readConfig(value: unknown): PopupConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const popup = (value as SiteConfig).popup as PopupConfig | undefined;
  if (typeof popup !== "object" || popup === null) return null;
  if (typeof popup.key !== "string" || popup.key.length === 0) return null;
  if (!Array.isArray(popup.variants) || popup.variants.length === 0) return null;
  if (!Array.isArray(popup.triggers)) return null;
  const frequency = popup.frequency;
  if (typeof frequency !== "object" || frequency === null) return null;
  return popup;
}

/**
 * 出すバリアントを選ぶ。
 * 🔴 **PR2 は先頭の1つだけ**(A/B の割り当ては PR5)。
 *   ⚠ サーバーは**毎回同じ順**で返すので、同じ訪問者に違うものは出ない。
 *   ⚠ `weight` は返ってきているが、**PR2 では1ミリも使っていない**。
 */
export function pickVariant(popup: PopupConfig): Variant | null {
  for (const variant of popup.variants) {
    if (isSafeDestination(variant?.destinationUrl)) return variant;
  }
  // 🔴 https でない遷移先しか無いポップは、出さない(要件書 §5-3 の描画時の検査)
  return null;
}

type Runtime = {
  win: Win;
  doc: Document;
  siteKey: string;
  deliveryOrigin: string;
  preview: boolean;
  device: "mobile" | "desktop";
  visitorHash: string;
  bridge: Bridge;
};

function pageUrlOf(win: Win): string {
  // 🔴 クエリとフラグメントを**送る前に**落とす(要件書 §6 裁定4。サーバー側でも削る)
  return `${win.location.origin}${win.location.pathname}`;
}

function makeSender(ctx: Runtime): (event: EventPayload) => void {
  const url = `${ctx.deliveryOrigin}${EVENTS_PATH}?site_key=${encodeURIComponent(ctx.siteKey)}`;
  return function send(event: EventPayload): void {
    quiet(() => {
      // 🔴 プレビューの表示は数値に数えない(要件書 §4-4)
      if (ctx.preview) return;
      const body = JSON.stringify(event);
      const nav = ctx.win.navigator as Navigator & {
        sendBeacon?: (url: string, data?: BodyInit) => boolean;
      };
      /*
        ⚠ **`text/plain` で送る**。`application/json` にすると preflight(OPTIONS)が要り、
          この API は OPTIONS を実装していない = **イベントが1件も届かなくなる**。
          単純リクエストの範囲に収めるのは、そのため。
      */
      try {
        if (typeof nav.sendBeacon === "function" && typeof ctx.win.Blob === "function") {
          const blob = new ctx.win.Blob([body], { type: "text/plain;charset=UTF-8" });
          if (nav.sendBeacon(url, blob)) return;
        }
      } catch {
        /* fetch へ落とす */
      }
      try {
        void ctx.win
          .fetch(url, {
            method: "POST",
            mode: "cors",
            credentials: "omit",
            keepalive: true,
            headers: { "content-type": "text/plain;charset=UTF-8" },
            body,
          })
          .catch(() => {
            /* 🔴 送れなくても LP は無傷 */
          });
      } catch {
        /* ここで終わり */
      }
    });
  };
}

/** 本体(`adpop.js`)を取りに行く。**発火して、抑制もされなかったときだけ**呼ばれる。 */
function loadRuntime(ctx: Runtime, request: RenderRequest): void {
  ctx.bridge.request = request;
  // 既に本体が居るなら、そのまま描かせる(多重読み込み耐性)
  if (typeof ctx.bridge.render === "function") {
    quiet(() => ctx.bridge.render?.());
    return;
  }
  const script = ctx.doc.createElement("script");
  script.async = true;
  script.src = `${ctx.deliveryOrigin}${RUNTIME_PATH}`;
  // ⚠ 読み込みに失敗しても何もしない(LP は無傷)
  script.onerror = () => {};
  const parent = ctx.doc.body ?? ctx.doc.head ?? ctx.doc.documentElement;
  parent?.appendChild(script);
}

function arm(ctx: Runtime, popup: PopupConfig): void {
  const storageKey = `adpop:${ctx.siteKey}:${popup.key}`;
  const armedAt = Date.now();
  const minDelayMs = Math.max(0, Number(popup.minDisplayDelaySeconds) || 0) * 1000;
  let fired = false;

  const enabled = popup.triggers
    .map((t) => t?.kind)
    .filter((kind): kind is TriggerKind => IMPLEMENTED_TRIGGERS.indexOf(kind as TriggerKind) >= 0);

  const send = ctx.bridge.send as (event: EventPayload) => void;

  function fire(kind: TriggerKind): void {
    quiet(() => {
      // 🔴 1ページの表示は最大1回(要件書 §4-2)。**最初に条件を満たしたトリガだけ**を記録する
      if (fired) return;
      // 🔴 最短表示待ち(既定3秒)。即バウンスに被せない
      if (Date.now() - armedAt < minDelayMs) return;
      fired = true;

      const pageUrl = pageUrlOf(ctx.win);
      const common = {
        popupKey: popup.key,
        visitorHash: ctx.visitorHash,
        device: ctx.device,
        pageUrl,
      };
      // 🔴 発火は**抑制された分も含めて**数える(要件書 §4-7)
      send({ ...common, kind: "fire", triggerKind: kind });

      const reason = ctx.preview
        ? null
        : suppressionReason(Date.now(), readState(ctx.win, storageKey), sessionCount(ctx.win, storageKey), {
            suppressDays: Number(popup.frequency.suppressDays) || 0,
            sessionImpressions: Math.max(1, Number(popup.frequency.sessionImpressions) || 1),
            postConversionDays: Number(popup.frequency.postConversionDays) || 0,
          });
      if (reason !== null) {
        // ⚠ 抑制は**表示には数えない**(要件書 §4-7)
        send({ ...common, kind: "suppressed", triggerKind: kind });
        return;
      }

      const variant = pickVariant(popup);
      if (variant === null) return;

      ctx.bridge.onShown = () => {
        quiet(() => {
          bumpSession(ctx.win, storageKey);
          writeState(ctx.win, storageKey, {
            ...(readState(ctx.win, storageKey) ?? {}),
            lastImpressionAt: Date.now(),
          });
        });
      };
      loadRuntime(ctx, {
        popupKey: popup.key,
        variant,
        triggerKind: kind,
        visitorHash: ctx.visitorHash,
        device: ctx.device,
        pageUrl,
        impressionId: uuid(ctx.win),
      });
    });
  }

  /*
    ── ① 戻るボタン(要件書 §4-2 の①)─────────────────────────────
    🔴 **埋め込み先の履歴を触る唯一のトリガ。** OFF なら `history` に1ミリも触らない。
      ⚠ 自前で `history` を使う SPA では干渉しうる(README に明記)。
  */
  if (enabled.indexOf("back") >= 0) {
    quiet(() => {
      ctx.win.history.pushState({ [NAMESPACE]: 1 }, "", ctx.win.location.href);
      ctx.win.addEventListener("popstate", () => fire("back"), { passive: true });
    });
  }

  /*
    ── ⑥ exit intent(PC のみ。要件書 §4-2 の⑥)────────────────────
    🔴 **タッチ端末では登録もしない**(誤爆源を作らない)。
  */
  if (enabled.indexOf("exit_intent") >= 0 && ctx.device === "desktop") {
    quiet(() => {
      ctx.doc.addEventListener(
        "mouseout",
        (event: MouseEvent) => {
          // 画面の上端へ抜けたときだけ。⚠ 子要素間の移動(relatedTarget あり)は無視
          if (event.relatedTarget !== null) return;
          if (typeof event.clientY === "number" && event.clientY <= 0) fire("exit_intent");
        },
        // ⚠ passive / 非キャプチャ(要件書 §5-2)。preventDefault は1度も呼ばない
        { passive: true },
      );
    });
  }
}

/**
 * 起動する。**同じサイトキーで2回貼られても1回しか動かない**(要件書 §5-2 の多重読み込み耐性)。
 * @returns 起動したら true。既に居る / タグが読めない / 失敗、なら false
 */
export function startAdpop(win: Win, doc: Document): boolean {
  if (readBridge(win) !== undefined) return false;

  const bridge: Bridge = { version: ADPOP_LOADER_VERSION };
  // 🔴 **最初に置く。** 置く前に何かで失敗すると、2回目の読み込みが素通りする
  writeBridge(win, bridge);

  const tag = readTag(doc);
  if (tag === null) return false;

  let preview = false;
  quiet(() => {
    preview = new URL(win.location.href).searchParams.get(PREVIEW_PARAM) === "1";
  });

  const ctx: Runtime = {
    win,
    doc,
    siteKey: tag.siteKey,
    deliveryOrigin: tag.deliveryOrigin,
    preview,
    device: isTouchDevice(win) ? "mobile" : "desktop",
    visitorHash: "",
    bridge,
  };

  // 匿名ID(要件書 §5-4)。⚠ サイトごとに分ける = サイトをまたいで突き合わせない
  const visitorKey = `adpop:visitor:${tag.siteKey}`;
  let stored: string | null = null;
  quiet(() => {
    stored = win.localStorage.getItem(visitorKey);
  });
  ctx.visitorHash = stored !== null && /^[0-9a-f]{32}$/.test(stored) ? stored : hex(32, win);
  if (stored !== ctx.visitorHash) quiet(() => win.localStorage.setItem(visitorKey, ctx.visitorHash));

  bridge.send = makeSender(ctx);

  /*
    ⚠ **ここから先は全部非同期。** LP の描画を1ミリも待たせない(要件書 §5-1)。
    ⚠ `fetch` が無い環境(古い端末)では**何もしない** —— polyfill を配らない(重くなる)。
  */
  quiet(() => {
    if (typeof win.fetch !== "function") return;
    const url = `${ctx.deliveryOrigin}${CONFIG_PATH}?site_key=${encodeURIComponent(ctx.siteKey)}`;
    void win
      .fetch(url, { method: "GET", mode: "cors", credentials: "omit", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        // 🔴 fail-closed: 形が読めなければ何もしない
        const popup = readConfig(value);
        if (popup !== null) arm(ctx, popup);
      })
      .catch(() => {
        // 🔴 配信が落ちても LP は無傷(ポップが出ないだけ)
      });
  });
  return true;
}

/*
  ⚠ **読み込まれたら自分で起動する**(タグ1本で動くことが要件)。
    テストは `vi.resetModules()` してから import し、**この行を通した状態**で測る
    (`startAdpop` を手で呼ぶだけだと、自動起動の経路を1度も通らない)。
*/
if (typeof window !== "undefined" && typeof document !== "undefined") {
  quiet(() => startAdpop(window as Win, document));
}
