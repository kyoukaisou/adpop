/*
  ADPOP の本体 —— **発火が決まってから取りに行く側**(要件書 §4-1 の2段構え)。
  MIT(このディレクトリのみ)。

  🔴 **テキスト型(§4-3 A)の見た目は仮置き**。枠・閉じるボタン・見出し・本文・ボタンだけ。
    デザインは別の工程(実寸のモックの承認)を通してから入れる。
  🔴 **画像型(§4-3 B)は 2026-10-04 追補 v2 の実寸モック(拓実さん承認済み)に合わせた**(PR4a)。
    画像全体が1つのリンクで、閉じるボタンは独立した要素。見た目を変える修正は、実物の寸法で
    見せて合意してから書く(組織の運転ルール)。
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
import { readBridge, TEXT_LIMITS, type Bridge, type CloseReason, type RenderRequest } from "./bridge";
import { imageUrlOf, isSafeDestination, textOf } from "./frequency";

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

/*
  ── 画像型(§4-3 B)。実寸モック(2026-10-04 追補 v2)の決定に合わせた ───────
  🔴 画像の高さは固定しない。比率どおりに高さが決まり、画面の高さの70%(スマホで検算した値)を
    超えたときだけ縮んで、そのときだけ左右に余白が出る(帯は出さない)。
*/
/* 🔴 実寸モック(06a〜06e)に合わせた値(text 型の 20rem/角丸 .5rem とは別の値)。 */
.image-panel {
  padding: 0; max-width: 22rem; border: 0; border-radius: 1rem; overflow: hidden;
  box-shadow: 0 20px 25px -5px rgba(0,0,0,.25), 0 8px 10px -6px rgba(0,0,0,.2);
}
.image-link { position: relative; display: block; }
.image-link:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
.image {
  display: block; width: 100%; height: auto; max-height: 70vh;
  object-fit: contain; background: #f2f1ec;
}
.image-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,0); pointer-events: none;
  transition: background-color .15s;
}
.image-link:hover .image-overlay { background: rgba(0,0,0,.18); }
@media (prefers-reduced-motion: reduce) { .image-overlay { transition: none; } }
/* 🔴 閉じるボタンは画像に重なるため独立した要素(押し間違えない間隔・44px 以上を維持) */
.close-image {
  position: absolute; top: .75rem; right: .75rem;
  min-width: 2.75rem; min-height: 2.75rem;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55); border: 0; border-radius: 50%;
  font-size: 1rem; color: #fff; cursor: pointer;
}
.close-image:hover { background: rgba(0,0,0,.7); }
.close-image:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.footer { padding: 1.25rem 1rem 1rem; }
.footer .headline { margin: 0 0 .75rem; }
.footer .cta { margin: 0; }
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
  const headline = textOf(content.headline, TEXT_LIMITS.headline);
  const body = textOf(content.body, TEXT_LIMITS.body);
  const rawButtonLabel = textOf(content.buttonLabel, TEXT_LIMITS.buttonLabel);
  const buttonLabel = rawButtonLabel || FALLBACK_BUTTON_LABEL;
  const imageAlt = textOf(content.imageAlt, TEXT_LIMITS.imageAlt);
  const isImage = request.variant.kind === "image";

  /*
    🔴 **画像型の2枚目の関門**(要件書 §5-3 の「保存時と描画時の両方で検査する」と同じ考え方)。
      配信(`DELIVERABLE_VARIANT`)は「`imageKey` が入っている画像型」だけを配るが、
      **この本体は配信の判定を信用しない** —— ローダを通さずに `bridge.request` を直接
      書き替えられた状態(上の `tests/embed-flow.test.ts` の「2枚目」と同じ経路)でも、
      形が崩れていれば何も描かない。
    ⚠ ここで throw すると `render()` は `bridge.shown` を立てない(=「出せなかった」が伝わる)。
  */
  const imageUrl = isImage ? imageUrlOf(request.deliveryOrigin, content.imageKey) : null;
  if (isImage && imageUrl === null) throw new Error("adpop: invalid image variant");

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
  panel.className = isImage ? "panel image-panel" : "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const closeButton = doc.createElement("button");
  closeButton.className = isImage ? "close-image" : "close";
  closeButton.type = "button";
  // 🔴 記号だけに意味を持たせない —— スクリーンリーダーには「閉じる」と読ませる
  closeButton.setAttribute("aria-label", "閉じる");
  closeButton.textContent = "✕";

  let heading: HTMLHeadingElement | null = null;
  if (headline !== "") {
    heading = doc.createElement("h2");
    heading.className = "headline";
    heading.id = "adpop-headline";
    heading.textContent = headline;
  }

  // ダイアログの名前。見出し > (画像型なら)画像の説明 > 既定の "お知らせ" の順(二重に読ませない)。
  if (heading !== null) {
    panel.setAttribute("aria-labelledby", heading.id);
  } else if (isImage && imageAlt !== "") {
    panel.setAttribute("aria-label", imageAlt);
  } else {
    panel.setAttribute("aria-label", DIALOG_LABEL);
  }

  // 画像リンクの名前(アクセシブルネーム)。**空にはしない**(imageAlt → headline → buttonLabel の順)。
  const imageLinkLabel = imageAlt || headline || buttonLabel;

  let imageLink: HTMLAnchorElement | null = null;
  let cta: HTMLAnchorElement | null = null;

  if (isImage) {
    /*
      ── 画像型(§4-3 B・2026-10-04 追補 v2)─────────────────────────
      🔴 **画像全体が1つのリンク**(拓実さん指示「画像やGIF自体がボタンの役割を果たす」)。
        ボタンは任意 —— ボタン文言が空なら画像だけのバナー、入っていれば画像の下にも同じ遷移先の
        ボタンを出す(同じ href を指す**別々の `<a>`**。入れ子にしない)。
    */
    imageLink = doc.createElement("a");
    imageLink.className = "image-link";
    imageLink.href = request.variant.destinationUrl;
    imageLink.rel = "noopener noreferrer";
    imageLink.setAttribute("aria-label", imageLinkLabel);

    const img = doc.createElement("img");
    img.className = "image";
    img.src = imageUrl as string;
    // ⚠ 画像の説明は <a> の aria-label が持つ(1つの画像に2つの名前を付けない)
    img.alt = "";
    imageLink.appendChild(img);

    const overlay = doc.createElement("div");
    overlay.className = "image-overlay";
    imageLink.appendChild(overlay);

    panel.appendChild(imageLink);
    panel.appendChild(closeButton);

    // フッター(見出し・ボタン)。どちらも無ければフッターそのものを出さない(画像だけのバナー)。
    if (heading !== null || rawButtonLabel !== "") {
      const footer = doc.createElement("div");
      footer.className = "footer";
      if (heading !== null) footer.appendChild(heading);
      if (rawButtonLabel !== "") {
        cta = doc.createElement("a");
        cta.className = "cta";
        cta.href = request.variant.destinationUrl;
        cta.rel = "noopener noreferrer";
        cta.textContent = buttonLabel;
        footer.appendChild(cta);
      }
      panel.appendChild(footer);
    }
  } else {
    // ── テキスト型(既存の見た目。§4-3 A)────────────────────────
    panel.appendChild(closeButton);
    if (heading !== null) panel.appendChild(heading);

    if (body !== "") {
      const paragraph = doc.createElement("p");
      paragraph.className = "body";
      paragraph.textContent = body;
      panel.appendChild(paragraph);
    }

    cta = doc.createElement("a");
    cta.className = "cta";
    // 🔴 描画の直前にもう一度確かめた URL しかここへ来ない(上の isSafeDestination)
    cta.href = request.variant.destinationUrl;
    cta.rel = "noopener noreferrer";
    cta.textContent = buttonLabel;
    panel.appendChild(cta);
  }

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
      // ⚠ **閉じ込める要素はここで決める**(フォーカスできる要素を足したら、ここにも足す)。
      const focusable = ([closeButton, imageLink, cta] as (HTMLElement | null)[]).filter(
        (el): el is HTMLElement => el !== null,
      );
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

  /*
    ⚠ **`preventDefault` を呼ばない。** 遷移はブラウザに任せ、送信は `sendBeacon` に任せる
      (遷移で中断されない = そのための API)。
    ⚠ 同じ表示で何度押されても**その数だけ**記録する(要件書 §4-7。CTR は畳んで出す)。
    🔴 **画像型は「画像リンク」「ボタン」が別々の `<a>`**(同じ遷移先)。どちらを押しても
      「ポップ内の誘導リンク / ボタンの押下」として同じ `click` イベントを送る(どちらで押したかは分けない)。
  */
  const sendClick = (): void => {
    send?.({
      kind: "click",
      popupKey: request.popupKey,
      variantKey: request.variant.key,
      impressionId: request.impressionId,
      visitorHash: request.visitorHash,
      device: request.device,
      pageUrl: request.pageUrl,
    });
  };
  imageLink?.addEventListener("click", sendClick);
  cta?.addEventListener("click", sendClick);

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
