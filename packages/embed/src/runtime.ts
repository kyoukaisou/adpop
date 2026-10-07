/*
  ADPOP の本体 —— **発火が決まってから取りに行く側**(要件書 §4-1 の2段構え)。
  MIT(このディレクトリのみ)。

  🔴 **テキスト型(§4-3 A)の見た目は仮置き**。枠・閉じるボタン・見出し・本文・ボタンだけ。
    デザインは別の工程(実寸のモックの承認)を通してから入れる。
  🔴 **画像型(§4-3 B)は 2026-10-04 追補 v2 の実寸モック(運営者承認済み)に合わせた**(PR4a)。
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
/*
  🔴 **`rem`/`em` を1つも使わない**(レビュー指摘)。`rem` は文書ルート(`<html>`)の
    `font-size` を基準にする —— `:host { all: initial }` は `:host` 自身の継承プロパティを遮るだけで、
    **`rem` の基準点(ルート要素)までは遮らない**。埋め込み先が `html { font-size: 10px }` のような
    LP だと、`2.75rem` は 44px ではなく 27.5px になり、「閉じるボタンは44px以上」が崩れる。
    **寸法は全部 px の絶対値**にする(1rem=16px だった値をそのまま px に置き換えた。見た目は変わらない)。
  ⚠ `vh`(`.image` の `max-height`)はビューポート基準で、文書ルートの `font-size` に左右されないので対象外。
*/
export const STYLE = `
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
  width: calc(100% - 32px); max-width: 320px;
  background: #fff; border: 1px solid #d4d4d4; border-radius: 8px;
  padding: 20px 16px 16px;
}
.headline { margin: 0 0 8px; font-size: 16px; font-weight: 700; }
.body { margin: 0 0 16px; font-size: 14px; }
.cta {
  /* ⚠ min-height は意匠ではなく**タッチターゲットの下限**(44px)。padding だけだと約40px になる */
  display: flex; align-items: center; justify-content: center; min-height: 44px;
  text-align: center; text-decoration: none;
  padding: 8px 16px; border-radius: 6px;
  background: #1a1a1a; color: #fff; font-size: 14px; font-weight: 700;
}
.close {
  position: absolute; top: 4px; right: 4px;
  min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: 0; border-radius: 6px;
  font-size: 16px; color: #1a1a1a; cursor: pointer;
}
/* 🔴 フォーカスリングを消さない(キーボードで操作できることが分かる) */
.cta:focus-visible, .close:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 2px; }

/*
  ── 画像型(§4-3 B)。実寸モック(2026-10-04 追補 v2)の決定に合わせた ───────
  🔴 画像の高さは固定しない。比率どおりに高さが決まり、画面の高さの70%(スマホで検算した値)を
    超えたときだけ縮んで、そのときだけ左右に余白が出る(帯は出さない)。
  🔴 「GIF」の印は出さない(2026-10-04 追補v2: 訪問者には不要。管理画面の種類の印はそのまま=LPには影響しない)。
*/
/* 🔴 実寸モック(06a〜06e)に合わせた値(text 型の 320px/角丸8px とは別の値)。 */
.image-panel {
  padding: 0; max-width: 352px; border: 0; border-radius: 16px; overflow: hidden;
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
  position: absolute; top: 12px; right: 12px;
  min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55); border: 0; border-radius: 50%;
  font-size: 16px; color: #fff; cursor: pointer;
}
.close-image:hover { background: rgba(0,0,0,.7); }
.close-image:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.footer { padding: 20px 16px 16px; }
.footer .headline { margin: 0 0 12px; }
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

/*
  🔴 **画像の読み込みを待つ上限**(レビュー指摘)。
    8 秒。根拠: 画像の上限は 2MB・GIF は 3MB(要件書 §4-3)で、低速回線でも常識的な時間で決着する
    大きさ。離脱の瞬間に出すポップなので早く諦めたいが、**短すぎるとモバイル回線で正しい画像まで
    「出せなかった」ことにしてしまう**(fail-closed の代償は「出ない」なので、閾値を切りすぎない側に倒す)。
    ⚠ 外部根拠は無い(実測に基づかない設計値)。待っている間は何も描かれない(訪問者には「出ないだけ」)ので、
    長めに倒しても実害は「タブが閉じられるまで見えない読み込みが続く」程度。
*/
export const IMAGE_LOAD_TIMEOUT_MS = 8000;

/**
 * 画像の読み込みを待つ(レビュー指摘)。
 * 🔴 **読み込みが成功するまで `src` を付けない呼び出し側と対**: `load` に先に耳を傾けてから `src` を立てる
 *   (キャッシュ即時発火でも取りこぼさない)。失敗(`error`)・上限超過はどちらも reject = **呼び出し側は
 *   「何も描かない」の1本で扱える**(成功と失敗のどちらで止まったかを区別しない)。
 */
function loadImage(win: Win, img: HTMLImageElement, src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      win.clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error("adpop: image load failed or timed out"));
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    const timer = win.setTimeout(() => finish(false), timeoutMs);
    img.src = src;
  });
}

/** 本体が読み込まれたときに1度だけ呼ばれる入口。 */
export function startRuntime(win: Win, doc: Document): boolean {
  const bridge = readBridge(win);
  // 🔴 ローダより先に読まれた / 別の何かが先に居る = 何もしない(fail-closed)
  if (bridge === undefined) return false;

  const render = (): void => {
    quiet(() => {
      if (bridge.shown === true || bridge.drawing === true) return;
      const request = bridge.request;
      if (request === undefined) return;
      if (!isSafeDestination(request.variant?.destinationUrl)) return;
      /*
        🔴🔴 **`shown` を立てるのは `draw()` が**通った後**(レビュー指摘)。
          前は先に立てていたので、**描画が途中で落ちても「表示済み」になっていた** ——
          ローダはそれを見て「出せた」と判断し、**戻るトリガが「戻る」を吸収したままになる**。
          = ポップも出ないのに操作だけ奪う(要件書 §5-2 の約束を破る)。
        🔴🔴 **`drawing` は `bridge` に持たせる(レビュー指摘)**。
          以前はこの関数のローカル変数だったため、**画像の読み込みを待っている間に本体がもう一度
          読み込まれる**(= `startRuntime()` がもう一度呼ばれる)と、2つ目の呼び出しは**別の
          ローカル変数**(常に `false` から始まる)を見てしまい、再入防止が効かなかった ——
          両方が同じ画像を並行に読み込み、両方成功すると**ポップが2つ・impressionも2件**になる
          (「本体が2回読み込まれても1つ」の約束=要件書 §5-2 の多重読み込み耐性に反する)。
          `bridge` は `readBridge(win)` でどの呼び出しからも**同じオブジェクト**が返るので、
          ここに置けば2つ目の `startRuntime()` が作る `render` からも正しく見える。
        ⚠ **失敗したら `shown` は false のまま**なので、ローダ側が「出せなかった」と判定できる。
        🔴 **画像型は `draw()` が画像の読み込みを待つ間 `Promise` のまま**(レビュー指摘)。
          `bridge.drawing` は、その**待っている間ずっと**立てたままにする。`bridge.render` 自体の
          型は同期(`() => void`)なので、ここで `await` はできない —— `.then`/`.catch` で結果を
          受けて `bridge.drawing`/`bridge.shown` を更新する。
      */
      bridge.drawing = true;
      draw(win, doc, bridge, request).then(
        () => {
          bridge.shown = true;
          bridge.drawing = false;
        },
        () => {
          // 🔴 失敗(画像読み込みの失敗・タイムアウト・不正な imageKey 等)。shown は立てない。
          bridge.drawing = false;
        },
      );
    });
  };

  bridge.render = render;
  // ローダが先に注文を置いていたら、そのまま描く
  if (bridge.request !== undefined) render();
  return true;
}

async function draw(win: Win, doc: Document, bridge: Bridge, request: RenderRequest): Promise<void> {
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
  let imageElement: HTMLImageElement | null = null;
  let cta: HTMLAnchorElement | null = null;

  if (isImage) {
    /*
      ── 画像型(§4-3 B・2026-10-04 追補 v2)─────────────────────────
      🔴 **画像全体が1つのリンク**(運営者指示「画像やGIF自体がボタンの役割を果たす」)。
        ボタンは任意 —— ボタン文言が空なら画像だけのバナー、入っていれば画像の下にも同じ遷移先の
        ボタンを出す(同じ href を指す**別々の `<a>`**。入れ子にしない)。
    */
    imageLink = doc.createElement("a");
    imageLink.className = "image-link";
    imageLink.href = request.variant.destinationUrl;
    imageLink.rel = "noopener noreferrer";
    imageLink.setAttribute("aria-label", imageLinkLabel);

    imageElement = doc.createElement("img");
    imageElement.className = "image";
    // ⚠ 画像の説明は <a> の aria-label が持つ(1つの画像に2つの名前を付けない)
    imageElement.alt = "";
    // 🔴 `src` はまだ付けない。読み込みの成否を待ってから差し込む(下の Blocker 2 の対処)。
    imageLink.appendChild(imageElement);

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
    🔴🔴 **「開く前」は DOM に差し込む直前を指す(レビュー指摘)**。
      画像型は `await loadImage(...)` で最大8秒待つ —— ここで先に読んでしまうと、
      **待っている間に利用者が別の要素へフォーカスを移していても、発火した瞬間の古い要素へ
      戻してしまう**。値を入れるのは下(画像の読み込みを待ったあと・`appendChild` の直前)。
      `close()` は `let` を閉包で捕まえているので、代入する場所を後にずらすだけでよい。
  */
  let previouslyFocused: HTMLElement | null = null;

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

  /*
    🔴 **画像の読み込みが成功するまで、何も差し込まない**(レビュー指摘)。
      既に設定を取得済みの LP が、差し替え・削除で消えた画像キーを持ったまま exit intent を発火させても、
      `/img/<key>` が 404(または読み込み中にタイムアウト)なら、ここで `loadImage` が reject し、
      `draw()` ごと失敗する(quiet() が外側で握る)。**DOM 挿入・`shown`・impression のどれも成立しない**
      = fail-closed(壊れた画像リンクを訪問者に見せない)。
    ⚠ **既知の限界**(本PRでは作らない猶予保持の代わり): 差し替え・削除の直後にちょうど発火した訪問者は、
      そのページを再読み込みするまでポップが出ない(README に書く)。
  */
  if (isImage && imageElement !== null) {
    await loadImage(win, imageElement, imageUrl as string, IMAGE_LOAD_TIMEOUT_MS);
  }

  // 🔴 差し込む直前のフォーカス位置(上の注記どおり、待った**あと**に読む)。
  previouslyFocused = doc.activeElement as HTMLElement | null;
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
