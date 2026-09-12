/*
  ADPOP の本体 —— **発火が決まってから取りに行く側**(要件書 §4-1 の2段構え)。
  MIT(このディレクトリのみ)。

  🔴 **見た目は仮置き。** 枠・閉じるボタン・見出し・本文・ボタンだけ。
    **デザインは PR3 で、実寸のモックを承認してから**入れる
    (見た目を変える修正は、実物の寸法で見せて合意してから書く)。
    ⚠ ここに色や余白を足すときは、必ずその工程を通す。

  🔴 **埋め込み先の CSS と混ざらない**(要件書 §5-2):
    ・**Shadow DOM に閉じる**。クラス名の prefix では、埋め込み先の `* { }` や `!important` に負ける
    ・`:host { all: initial }` で、**継承される性質(font / color / line-height)も遮る**
      —— Shadow DOM は子孫セレクタは止めるが、**継承は止めない**
  ⚠ `mode` は **`open`**。`closed` にしても **CSS の隔離は1ミリも変わらない**(隔離は Shadow root が担う)。
    変わるのは「LP の JS から中を読めるか」だけで、**LP の持ち主は元々こちらを貼った人**なので
    そこは守る対象ではない。`open` にしておくと**開発と検査で中を確かめられる**。

  🔴 **任意 HTML を1文字も受け取らない**(要件書 §3 除外5 / §5-3):
    見出し・本文・ボタン文言は **`textContent` にしか入れない**。`innerHTML` を使わない。
*/
import { readBridge, type Bridge, type CloseReason, type RenderRequest } from "./bridge";
import { isSafeDestination, textOf } from "./frequency";

export const ADPOP_RUNTIME_VERSION = "0.1.0";

/** 仮置きの文言。⚠ **設定に文言が無いときだけ**使う(内部用語を出さない)。 */
const FALLBACK_BUTTON_LABEL = "詳しく見る";
const DIALOG_LABEL = "お知らせ";

/*
  ⚠ この文字列だけが `textContent` 経由でスタイルとして入る。**利用者の入力は1文字も混ざらない。**
*/
const STYLE = `
:host { all: initial; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.6; color: #1a1a1a;
}
.panel {
  position: relative; box-sizing: border-box;
  width: calc(100% - 2rem); max-width: 20rem;
  background: #fff; border: 1px solid #d4d4d4; border-radius: .5rem;
  padding: 1.25rem 1rem 1rem;
}
.headline { margin: 0 0 .5rem; font-size: 1rem; font-weight: 700; }
.body { margin: 0 0 1rem; font-size: .875rem; }
.cta {
  /* ⚠ min-height は意匠ではなく**タッチターゲットの下限**(44px)。padding だけだと約40px になる */
  display: flex; align-items: center; justify-content: center; min-height: 2.75rem;
  text-align: center; text-decoration: none;
  padding: .5rem 1rem; border-radius: .375rem;
  background: #1a1a1a; color: #fff; font-size: .875rem; font-weight: 700;
}
.close {
  position: absolute; top: .25rem; right: .25rem;
  min-width: 2.75rem; min-height: 2.75rem;
  display: flex; align-items: center; justify-content: center;
  background: none; border: 0; border-radius: .375rem;
  font-size: 1rem; color: #1a1a1a; cursor: pointer;
}
/* 🔴 フォーカスリングを消さない(キーボードで操作できることが分かる) */
.cta:focus-visible, .close:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 2px; }
`;

type Win = Window & typeof globalThis;

function quiet(run: () => void): void {
  try {
    run();
  } catch {
    /* 🔴 LP を1ミリも壊さない */
  }
}

/** 本体が読み込まれたときに1度だけ呼ばれる入口。 */
export function startRuntime(win: Win, doc: Document): boolean {
  const bridge = readBridge(win);
  // 🔴 ローダより先に読まれた / 別の何かが先に居る = 何もしない(fail-closed)
  if (bridge === undefined) return false;

  let drawing = false;
  const render = (): void => {
    quiet(() => {
      if (bridge.shown === true || drawing) return;
      const request = bridge.request;
      if (request === undefined) return;
      if (!isSafeDestination(request.variant?.destinationUrl)) return;
      /*
        🔴🔴 **`shown` を立てるのは `draw()` が**通った後**(Codex 3巡目 Blocker)。
          前は先に立てていたので、**描画が途中で落ちても「表示済み」になっていた** ——
          ローダはそれを見て「出せた」と判断し、**戻るトリガが「戻る」を吸収したままになる**。
          = ポップも出ないのに操作だけ奪う(要件書 §5-2 の約束を破る)。
        ⚠ `drawing` は**再入だけ**を止める(`draw` の途中で render がもう一度呼ばれても二重に描かない)。
          **失敗したら `shown` は false のまま**なので、ローダ側が「出せなかった」と判定できる。
      */
      drawing = true;
      try {
        draw(win, doc, bridge, request);
        bridge.shown = true;
      } finally {
        drawing = false;
      }
    });
  };

  bridge.render = render;
  // ローダが先に注文を置いていたら、そのまま描く
  if (bridge.request !== undefined) render();
  return true;
}

function draw(win: Win, doc: Document, bridge: Bridge, request: RenderRequest): void {
  const send = bridge.send;
  const content = request.variant.content ?? {};
  const headline = textOf(content.headline);
  const body = textOf(content.body, 600);
  const buttonLabel = textOf(content.buttonLabel, 60) || FALLBACK_BUTTON_LABEL;

  const host = doc.createElement("div");
  // ⚠ LP の CSS が拾える手掛かりを1つだけ残す(ポップの存在は隠さない)
  host.setAttribute("data-adpop", "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = doc.createElement("style");
  style.textContent = STYLE;
  shadow.appendChild(style);

  const backdrop = doc.createElement("div");
  backdrop.className = "backdrop";

  const panel = doc.createElement("div");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const closeButton = doc.createElement("button");
  closeButton.className = "close";
  closeButton.type = "button";
  // 🔴 記号だけに意味を持たせない —— スクリーンリーダーには「閉じる」と読ませる
  closeButton.setAttribute("aria-label", "閉じる");
  closeButton.textContent = "✕";
  panel.appendChild(closeButton);

  if (headline !== "") {
    const heading = doc.createElement("h2");
    heading.className = "headline";
    heading.id = "adpop-headline";
    heading.textContent = headline;
    panel.appendChild(heading);
    // 見出しが在るならそれをダイアログの名前にする(二重に読ませない)
    panel.setAttribute("aria-labelledby", heading.id);
  } else {
    panel.setAttribute("aria-label", DIALOG_LABEL);
  }

  if (body !== "") {
    const paragraph = doc.createElement("p");
    paragraph.className = "body";
    paragraph.textContent = body;
    panel.appendChild(paragraph);
  }

  const cta = doc.createElement("a");
  cta.className = "cta";
  // 🔴 描画の直前にもう一度確かめた URL しかここへ来ない(上の isSafeDestination)
  cta.href = request.variant.destinationUrl;
  cta.rel = "noopener noreferrer";
  cta.textContent = buttonLabel;
  panel.appendChild(cta);

  backdrop.appendChild(panel);
  shadow.appendChild(backdrop);

  let closed = false;
  /*
    🔴 **開く前にフォーカスが在った場所を覚えておく**(提出前セルフレビュー H3)。
      閉じたあと `host.remove()` するだけだと、フォーカスは `body` の先頭へ飛び、
      **キーボードで読んでいた人は位置を失う**。
    ⚠ `document.activeElement` は Shadow root の外側の要素を指す(ポップはまだ挿していない)。
  */
  const previouslyFocused = doc.activeElement as HTMLElement | null;

  /**
   * 🔴 **`aria-modal="true"` を名乗るなら、フォーカスも実際に閉じ込める**
   *   (提出前セルフレビュー H1)。
   *   宣言だけして Tab が背後の LP へ抜けると、**支援技術には「背後は不活性」と伝えながら
   *   キーボードでは背後を操作できる** = 説明が実装より広い約束になる。
   * ⚠ 閉じ込めるのはこの2つだけ(閉じるボタンと誘導リンク)。
   *   フォーカスできる要素をポップに足したら、ここも足す。
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      close("esc");
      return;
    }
    if (event.key !== "Tab") return;
    quiet(() => {
      const focusable: HTMLElement[] = [closeButton, cta];
      const index = focusable.indexOf(shadow.activeElement as HTMLElement);
      // ⚠ ポップの外に居るなら、まず中へ引き戻す(index が -1 のとき)
      const next = event.shiftKey
        ? focusable[(index <= 0 ? focusable.length : index) - 1]
        : focusable[index < 0 ? 0 : (index + 1) % focusable.length];
      /*
        ⚠ **要件書 §5-2「`preventDefault` はポップ自身の要素の上でしか呼ばない」の例外。**
          この listener は `document` に付いている(フォーカスがどこに在っても Esc と Tab を拾うため)。
          🔴 ただし **ポップが開いている間だけ**で、閉じたら `removeEventListener` する。
            `aria-modal="true"` を名乗る以上、背後へ Tab で抜けさせないのが**約束の側**。
          ⚠ **Tab と Escape 以外のキーには1つも触らない**(LP のショートカットを止めない)。
      */
      event.preventDefault();
      next.focus();
    });
  };

  function close(reason: CloseReason): void {
    quiet(() => {
      if (closed) return;
      closed = true;
      doc.removeEventListener("keydown", onKeyDown);
      host.remove();
      // ⚠ 消えた要素にフォーカスが残らないよう、元の場所へ戻す
      quiet(() => previouslyFocused?.focus());
      send?.({
        kind: "close",
        popupKey: request.popupKey,
        variantKey: request.variant.key,
        impressionId: request.impressionId,
        visitorHash: request.visitorHash,
        device: request.device,
        pageUrl: request.pageUrl,
        closeReason: reason,
      });
    });
  }

  closeButton.addEventListener("click", () => close("button"));
  // 背景タップで閉じる(要件書 §4-3 の共通)。⚠ パネルの中のクリックは拾わない
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close("backdrop");
  });
  cta.addEventListener("click", () => {
    /*
      ⚠ **`preventDefault` を呼ばない。** 遷移はブラウザに任せ、送信は `sendBeacon` に任せる
        (遷移で中断されない = そのための API)。
      ⚠ 同じ表示で何度押されても**その数だけ**記録する(要件書 §4-7。CTR は畳んで出す)。
    */
    send?.({
      kind: "click",
      popupKey: request.popupKey,
      variantKey: request.variant.key,
      impressionId: request.impressionId,
      visitorHash: request.visitorHash,
      device: request.device,
      pageUrl: request.pageUrl,
    });
  });

  const parent = doc.body ?? doc.documentElement;
  parent.appendChild(host);
  doc.addEventListener("keydown", onKeyDown);
  quiet(() => closeButton.focus());

  /*
    🔴 **表示(impression)の数え方は要件書 §4-7 のとおり**:
      「Shadow root への挿入完了」+「`requestAnimationFrame` 1フレーム後も
       `document.visibilityState === "visible"`」の**両方**。
    ⚠ **DOM に入れただけ・タブが隠れている間は数えない**(隠れている間に出しても見えないうえ、
      表示として数えると水増しになる)。
    ⚠ 数えなかったときは `bridge.onShown` も呼ばない = **頻度制御の記録も残さない**
      (見えていない表示で7日間の抑制を始めない)。
  */
  const countImpression = (): void => {
    quiet(() => {
      if (closed) return;
      if (doc.visibilityState !== "visible") return;
      send?.({
        kind: "impression",
        popupKey: request.popupKey,
        variantKey: request.variant.key,
        triggerKind: request.triggerKind,
        impressionId: request.impressionId,
        visitorHash: request.visitorHash,
        device: request.device,
        pageUrl: request.pageUrl,
      });
      bridge.onShown?.();
    });
  };
  if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(countImpression);
  else countImpression();
}

/*
  ⚠ 読み込まれたら自分で起動する(ローダが `<script>` を足すだけで動く)。
*/
if (typeof window !== "undefined" && typeof document !== "undefined") {
  quiet(() => startRuntime(window as Win, document));
}
