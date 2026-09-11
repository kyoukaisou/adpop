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
/**
 * 本体(`adpop.js`)を取りに行く。**発火して、抑制もされなかったときだけ**呼ばれる。
 *
 * @param onGaveUp **出せなかったと確定したとき**に1度だけ呼ばれる。
 *   🔴🔴 **これが無いのが欠陥だった**(Codex 2巡目 Blocker 3)。
 *     `fire()` は**本体の読み込みが成功する前に**「出す」と答えていたので、
 *     **CDN 障害・CSP・広告ブロッカーで本体が落ちたとき**、
 *     ポップは出ないのに**戻るトリガが「戻る」を1回吸収したまま**になっていた。
 *     = **「配信が落ちてもポップが出ないだけ」という約束(要件書 §5-2)を破っていた。**
 *   ✅ 「出せなかった」を**呼び出し側へ返す**ことで、戻るトリガが `history.back()` で通し直せる。
 *   ⚠ **`onload` でも呼ぶ** —— 読み込めたのに描かれなかった場合(bridge の取り違え等)も
 *     「出せなかった」に含める。**読み込みの成否ではなく、描かれたかどうかで決める。**
 */
function loadRuntime(ctx: Runtime, request: RenderRequest, onGaveUp?: () => void): void {
  ctx.bridge.request = request;
  let settled = false;
  const giveUpOnce = (): void => {
    quiet(() => {
      if (settled) return;
      settled = true;
      // 🔴 描かれていたら何もしない(出せている)
      if (ctx.bridge.shown === true) return;
      onGaveUp?.();
    });
  };

  // 既に本体が居るなら、そのまま描かせる(多重読み込み耐性)
  if (typeof ctx.bridge.render === "function") {
    quiet(() => ctx.bridge.render?.());
    giveUpOnce();
    return;
  }
  /*
    🔴🔴 **生成と挿入そのものが同期で落ちることがある**(Codex 3巡目 Blocker)。
      代表例は **Trusted Types を要求する CSP** —— `script.src` への代入が例外になる。
      try/catch が無いと `quiet` が外側で握るだけで、**`onGaveUp` に1度も到達しない**
      = **出せていないのに「出せた」ことになり、戻るが吸収されたままになる。**
  */
  try {
    const script = ctx.doc.createElement("script");
    script.async = true;
    script.src = `${ctx.deliveryOrigin}${RUNTIME_PATH}`;
    script.onerror = giveUpOnce;
    script.onload = giveUpOnce;
    const parent = ctx.doc.body ?? ctx.doc.head ?? ctx.doc.documentElement;
    if (parent === null) {
      // 挿す先が無い = 出せない
      giveUpOnce();
      return;
    }
    parent.appendChild(script);
  } catch {
    giveUpOnce();
  }
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

  /**
   * @returns **これから出す**と決まったら true。
   *   ⚠ 「出さない」には *抑制された* / *既に出した* / *出せるバリアントが無い* / *早すぎる* が全部入る。
   *   🔴 呼ぶ側(戻るトリガ)は、false のときに**利用者の「戻る」を通し直す**必要がある。
   */
  function fire(kind: TriggerKind, onGaveUp?: () => void): boolean {
    let willShow = false;
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
      willShow = true;
      loadRuntime(
        ctx,
        {
          popupKey: popup.key,
          variant,
          triggerKind: kind,
          visitorHash: ctx.visitorHash,
          device: ctx.device,
          pageUrl,
          impressionId: uuid(ctx.win),
        },
        onGaveUp,
      );
    });
    return willShow;
  }

  /*
    ── ① 戻るボタン(要件書 §4-2 の①)─────────────────────────────
    🔴 **埋め込み先の履歴を触る唯一のトリガ。** OFF なら `history` に1ミリも触らない。
      ⚠ 自前で `history` を使う SPA では干渉しうる(README に明記)。
  */
  if (enabled.indexOf("back") >= 0) {
    /*
      🔴🔴 **2つとも直した**(Codex 1巡目・両モデル):

      ① **最短表示待ちの間に戻ると、以後まったく発火しなくなっていた**(sol)
         読み込み直後に履歴を1枚積んでいたので、**待ちの間の「戻る」がその1枚を食い**、
         `fire()` は早すぎるので何もせず、**もう積み直さない**ので二度と発火しない。
         ✅ **積むのを待ちが明けてからにした。** 待ちの間の「戻る」は**普通の離脱**として通す
           (そもそもその時間帯は出さないと決めているので、履歴に触る理由が無い)。

      ② **出さないと決まった後でも、「戻る」を1回吸収していた**(Astra)
         抑制された・出せるバリアントが無い・既に別のトリガで出した —— どの場合でも
         積んだ1枚が消費され、**利用者は「戻る」を押したのに何も起きない**。
         🔴 これは「**配信が落ちてもポップが出ないだけ**」という約束(要件書 §5-2)を破っている。
         ✅ **出さないと決めたら `history.back()` で利用者の意図を通し直す。**
           ⚠ 先に listener を外してから呼ぶ(外さないと popstate が再入して**履歴を遡り続ける**)。
    */
    const onPopState = (): void => {
      quiet(() => ctx.win.removeEventListener("popstate", onPopState));
      /*
        🔴 **「戻る」を通し直すのは1回だけ。** 同期に決まる場合(抑制・バリアント無し・既に表示済み)と、
          **非同期に決まる場合(本体の読み込みが落ちた)**の両方から呼ばれる。
      */
      let restored = false;
      /*
        🔴🔴 **通し直しを「あの時の履歴の位置」に結び付ける**(Codex 3巡目 Blocker)。
          本体の読み込みを待っている間に **埋め込み先の SPA が別の state を push** すると、
          そのあとの `history.back()` は**こちらが積んだ1枚ではなく、SPA の遷移を巻き戻す**
          = **利用者の操作を勝手に取り消す。**
        ✅ popstate を受けた時点の `history.length` を覚えておき、**増えていたら通し直さない**。
        ⚠ **限界**: `history.length` は `pushState` でしか増えないので、
          **`replaceState` だけで動く SPA は見分けられない**(その場合は通し直してしまう)。
          ⚠ また、**長さが上限(ブラウザ既定で 50 前後)に達していると増えない**ので、同じく見分けられない。
          🔴 それでも**「触らない側」に倒れる**方向の判定なので、外したときの害は
            「戻るが1回効かない」で止まる(**LP の履歴を壊すより軽い**)。
      */
      let lengthAtPopState = 0;
      quiet(() => {
        lengthAtPopState = ctx.win.history.length;
      });
      const restore = (): void =>
        quiet(() => {
          if (restored) return;
          restored = true;
          // 🔴 待っている間に誰かが履歴を積んでいたら、触らない
          if (ctx.win.history.length !== lengthAtPopState) return;
          ctx.win.history.back();
        });
      if (!fire("back", restore)) restore();
    };
    const armBack = (): void =>
      quiet(() => {
        // 既に別のトリガで出したなら、埋め込み先の履歴に1ミリも触らない
        if (fired) return;
        ctx.win.history.pushState({ [NAMESPACE]: 1 }, "", ctx.win.location.href);
        ctx.win.addEventListener("popstate", onPopState, { passive: true });
      });
    if (minDelayMs > 0) ctx.win.setTimeout(armBack, minDelayMs);
    else armBack();
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
