// @vitest-environment node
//
// 埋め込みスクリプトの**流れ**の検査(要件書 §4-2 / §4-4 / §4-7 / §5-3)。
//
// ⚠ 役割の分担:
//   ・こちら = **何が送られ、何が描かれるか**(ソースの module を、**テストごとに作り直した DOM** で動かす)
//   ・`tests/embed-safety.test.ts` = **周りに何をしないか**(束ねた出力を、ブラウザと同じ経路で実行)
//
// 🔴 **DOM をテストごとに作り直す。**
//   vitest の jsdom 環境は**ファイルで1つ**なので、`document` / `window` に付けた
//   listener が**次のテストへ残る** —— 実測(2026-09-09)で、3つ前のテストが仕掛けた
//   `popstate` が発火し、`fire` が3件届いた。**「前のテストの残骸」を測っていた。**
//   → `jsdom` を直接使い、テストごとに新しい window を作る。
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE, type Bridge, type EventPayload } from "../packages/embed/src/bridge";
import { IMPLEMENTED_TRIGGERS, startAdpop } from "../packages/embed/src/loader";
import { IMAGE_LOAD_TIMEOUT_MS, startRuntime } from "../packages/embed/src/runtime";

const SITE_KEY = "0123456789abcdef0123456789abcdef";
const POPUP_KEY = "p".repeat(32);
const VARIANT_KEY = "v".repeat(32);
const DELIVERY = "https://delivery.example.com";
const PAGE = "https://lp.example.com/lp";

type Win = Window & typeof globalThis;

type PopupOverrides = {
  minDisplayDelaySeconds?: number;
  frequency?: { suppressDays: number; sessionImpressions: number; postConversionDays: number };
  triggers?: Array<{ kind: string; threshold: number | null }>;
  variants?: Array<Record<string, unknown>>;
};

function configBody(overrides: PopupOverrides = {}): string {
  return JSON.stringify({
    v: 1,
    popup: {
      key: POPUP_KEY,
      minDisplayDelaySeconds: overrides.minDisplayDelaySeconds ?? 0,
      frequency: overrides.frequency ?? {
        suppressDays: 0,
        sessionImpressions: 1,
        postConversionDays: 0,
      },
      triggers: overrides.triggers ?? [
        { kind: "back", threshold: null },
        { kind: "exit_intent", threshold: null },
      ],
      variants: overrides.variants ?? [
        {
          key: VARIANT_KEY,
          kind: "text",
          weight: 100,
          content: { headline: "まだ間に合います", body: "本文", buttonLabel: "確認する" },
          destinationUrl: "https://offer.example.com/a",
        },
      ],
    },
  });
}

let dom: JSDOM;
let win: Win;
let doc: Document;
/** 送られたイベント。⚠ `sendBeacon` は jsdom に無いので `fetch` に落ちる。 */
let sent: EventPayload[];
let configRequests: string[];

function newDom(url = PAGE): void {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url,
    pretendToBeVisual: true, // ⚠ これが無いと visibilityState が "prerender" のまま
  });
  win = dom.window as unknown as Win;
  doc = win.document;
  // 1フレーム後の判定(要件書 §4-7)を**その場で**回す
  (win as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame =
    (cb) => {
      cb();
      return 0;
    };
}

function stubNetwork(options: { config?: string | null; status?: number } = {}): void {
  const body = options.config === undefined ? configBody() : options.config;
  (win as unknown as { fetch: unknown }).fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/events")) {
        sent.push(JSON.parse(String(init?.body)) as EventPayload);
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) });
      }
      configRequests.push(url);
      if (body === null) return Promise.reject(new Error("network"));
      const status = options.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(JSON.parse(body) as unknown),
      });
    },
  );
}

function installTag(): void {
  const script = doc.createElement("script");
  script.setAttribute("data-adpop-site", SITE_KEY);
  script.src = `${DELIVERY}/embed/t.js`;
  doc.head.appendChild(script);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function exitIntent(): void {
  doc.dispatchEvent(new win.MouseEvent("mouseout", { clientY: 0, relatedTarget: null }));
}

/** ポップの中身(Shadow root の中)。⚠ `mode: "open"` にしてあるので読める。 */
function popup(): ShadowRoot | null {
  return doc.querySelector("[data-adpop]")?.shadowRoot ?? null;
}

/** ローダが `<script>` を足した後、本体が読み込まれた状況を作る。 */
async function bootRuntime(): Promise<void> {
  startRuntime(win, doc);
  await flush();
}

async function bootLoader(): Promise<void> {
  startAdpop(win, doc);
  await flush();
}

beforeEach(() => {
  sent = [];
  configRequests = [];
  newDom();
});

afterEach(() => {
  dom.window.close();
  vi.restoreAllMocks();
});

describe("トリガ(PR2 で動くのは ⑥exit intent の1つだけ)", () => {
  it("🔴 PR2 で動くトリガは exit intent の1つだけ(2026-09-12 本部裁定)", () => {
    /*
      🔴 **「戻る」は PR4 へ送った。** 4巡のうち3巡で、この1機能から Blocker が出続けたため。
        ⚠ **設定の型は残してある**(DB の enum・`popup_triggers` の行)ので、
          サーバーは `back` を有効として返しうる。**ここが無視する。**
      ⚠ ここを増やすだけでは何も起きない(仕掛ける側のコードが無い)が、
        **増えたことに気づける**ようにしておく —— PR4 で戻すときの入口はここ。
    */
    expect([...IMPLEMENTED_TRIGGERS]).toEqual(["exit_intent"]);
  });

  it("⑥ exit intent で発火し、本体を取りに行く", async () => {
    stubNetwork();
    installTag();
    await bootLoader();

    expect(configRequests).toEqual([`${DELIVERY}/api/v1/config?site_key=${SITE_KEY}`]);
    expect(sent).toEqual([]);

    exitIntent();
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire"]);
    expect(sent[0].triggerKind).toBe("exit_intent");
    expect(doc.querySelector(`script[src="${DELIVERY}/embed/adpop.js"]`)).not.toBeNull();
  });

  it("⑥ 画面の上端でないマウスアウトでは発火しない", async () => {
    stubNetwork();
    installTag();
    await bootLoader();

    doc.dispatchEvent(new win.MouseEvent("mouseout", { clientY: 200, relatedTarget: null }));
    // 子要素間の移動(relatedTarget あり)も発火しない
    doc.dispatchEvent(new win.MouseEvent("mouseout", { clientY: 0, relatedTarget: doc.body }));
    await flush();

    expect(sent).toEqual([]);
  });

  it("🔴 1ページの表示は最大1回(最初に条件を満たしたトリガだけを記録する)", async () => {
    stubNetwork();
    installTag();
    await bootLoader();

    exitIntent();
    exitIntent();
    await flush();

    expect(sent.filter((e) => e.kind === "fire")).toHaveLength(1);
    expect(sent[0].triggerKind).toBe("exit_intent");
  });

  it("🔴 最短表示待ちの間は、条件を満たしても出さない(即バウンスに被せない)", async () => {
    stubNetwork({ config: configBody({ minDisplayDelaySeconds: 30 }) });
    installTag();
    await bootLoader();

    exitIntent();
    await flush();

    expect(sent).toEqual([]);
  });

  it("🔴 タッチ端末では exit intent を**登録しない**(誤爆源を作らない)", async () => {
    (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
    stubNetwork();
    installTag();
    await bootLoader();

    exitIntent();
    await flush();
    expect(sent, "タッチ端末なのに exit intent が登録されている").toEqual([]);

    /*
      ⚠ **端末の2値そのものは、ここでは測れない。**
        PR2 で動くトリガは exit intent の1つだけで、それはタッチ端末では登録しないので、
        **スマホ側で送られるイベントが1件も無い**(「戻る」は PR4 へ送った)。
        → 2値の判定は、下の `maxTouchPoints` の it が **desktop 側**で測っている。
        **測れないものを、測ったふりで書かない。**
    */
  });

  it("🔴 `ontouchstart` が在るだけの環境を「スマホ」と数えない(PC の Chrome / jsdom がこれ)", async () => {
    /*
      🔴 2026-09-09 に**実装の誤りとして見つけた**もの。
        当初 `isTouchDevice` は `matchMedia` が無いとき `"ontouchstart" in window` に落ちていた。
        ところが **jsdom でも、デスクトップの Chrome でも true** になる
        (ハードウェアではなく「Touch Events の API を実装しているか」を見ているため)。
        → **PC が「スマホ」と数えられ、⑥exit intent が1度も登録されない**。
        ⚠ fail-closed なので**誰も気づかない**(ポップが出なくなるだけ)。
      ✅ `navigator.maxTouchPoints`(**ハードウェアを見る**)に変えた。
    */
    expect("ontouchstart" in win, "この前提が崩れたら、この検査は何も測っていない").toBe(true);
    /*
      ⚠ **jsdom は `maxTouchPoints` を実装していない**(2026-09-09 実測で `undefined`)。
        だからここは「数値が1以上か」で見る実装の、**数値ですらない**側を通っている。
        実物のデスクトップ Chrome では `0` が入る(ハードウェアを見るため)。
        → **jsdom で測れているのは「`ontouchstart` を見ていないこと」まで**で、
          「`maxTouchPoints === 0` を desktop と数えること」は下の別の it が受け持つ。
    */
    expect(win.navigator.maxTouchPoints).toBeUndefined();

    stubNetwork();
    installTag();
    await bootLoader();
    exitIntent();
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire"]);
    expect(sent[0].device).toBe("desktop");
  });

  it("`maxTouchPoints` が 0 なら PC(exit intent が登録される)", async () => {
    // ⚠ jsdom は `maxTouchPoints` を持たないので、**実物のデスクトップ Chrome の値を置いてから**測る
    Object.defineProperty(win.navigator, "maxTouchPoints", { value: 0, configurable: true });
    stubNetwork();
    installTag();
    await bootLoader();

    exitIntent();
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire"]);
    expect(sent[0].device).toBe("desktop");
  });

  it("`maxTouchPoints` が1以上ならスマホ(exit intent を登録しない)", async () => {
    Object.defineProperty(win.navigator, "maxTouchPoints", { value: 5, configurable: true });
    stubNetwork();
    installTag();
    await bootLoader();

    exitIntent();
    await flush();
    expect(sent, "スマホなのに exit intent が登録されている").toEqual([]);

    // ⚠ スマホでは PR2 に動くトリガが1つも無い(「戻る」は PR4 へ送った)ので、
    //   ここで測れるのは「**exit intent を登録しない**」ことまで。
    //   端末の2値そのものは、下の `maxTouchPoints` の it が見る。
  });

  it("⚠ PR2 が知らないトリガ(スクロール等)は無視する = 何も起きない", async () => {
    stubNetwork({ config: configBody({ triggers: [{ kind: "scroll", threshold: 50 }] }) });
    installTag();
    await bootLoader();

    win.dispatchEvent(new win.Event("scroll"));
    exitIntent();
    await flush();

    expect(sent).toEqual([]);
  });
});

describe("頻度制御(要件書 §4-4 / §4-7)", () => {
  it("🔴 抑制されたときは `fire` と `suppressed` を送り、本体を取りに行かない", async () => {
    win.localStorage.setItem(
      `adpop:${SITE_KEY}:${POPUP_KEY}`,
      JSON.stringify({ lastImpressionAt: Date.now() }),
    );
    stubNetwork({
      config: configBody({
        frequency: { suppressDays: 7, sessionImpressions: 1, postConversionDays: 0 },
      }),
    });
    installTag();
    await bootLoader();

    exitIntent();
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire", "suppressed"]);
    expect(doc.querySelector("script[src*='adpop.js']")).toBeNull();
  });

  it("表示すると、次のページ読み込みでは抑制される(記録はローダが持つ)", async () => {
    const frequency = { suppressDays: 7, sessionImpressions: 5, postConversionDays: 0 };
    stubNetwork({ config: configBody({ frequency }) });
    installTag();
    await bootLoader();
    exitIntent();
    await flush();
    await bootRuntime();
    expect(sent.map((e) => e.kind)).toEqual(["fire", "impression"]);

    // 2ページ目。⚠ **同じ localStorage を引き継ぐ**(同じ訪問者)
    const storage = Object.fromEntries(
      Object.keys(win.localStorage).map((key) => [key, win.localStorage.getItem(key) ?? ""]),
    );
    sent = [];
    newDom();
    for (const [key, value] of Object.entries(storage)) win.localStorage.setItem(key, value);
    stubNetwork({ config: configBody({ frequency }) });
    installTag();
    await bootLoader();
    exitIntent();
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire", "suppressed"]);
  });

  it("🔴 プレビュー(?adpop_preview=1)は頻度制御を無視し、**1件も数えない**", async () => {
    newDom(`${PAGE}?adpop_preview=1`);
    win.localStorage.setItem(
      `adpop:${SITE_KEY}:${POPUP_KEY}`,
      JSON.stringify({ lastImpressionAt: Date.now() }),
    );
    stubNetwork({
      config: configBody({
        frequency: { suppressDays: 30, sessionImpressions: 1, postConversionDays: 0 },
      }),
    });
    installTag();
    await bootLoader();
    exitIntent();
    await flush();
    await bootRuntime();

    // 出ている
    expect(popup()?.querySelector(".panel")).not.toBeNull();
    // ⚠ しかし1件も送っていない(要件書 §4-4)
    expect(sent).toEqual([]);
  });
});

describe("表示(本体)", () => {
  async function show(overrides: PopupOverrides = {}): Promise<void> {
    stubNetwork({ config: configBody(overrides) });
    installTag();
    await bootLoader();
    exitIntent();
    await flush();
    await bootRuntime();
  }

  it("Shadow DOM の中に描かれ、表示イベントが1件送られる", async () => {
    await show();
    const root = popup();
    expect(root, "Shadow root が無い").not.toBeNull();
    expect(root?.querySelector(".headline")?.textContent).toBe("まだ間に合います");
    expect(root?.querySelector(".cta")?.getAttribute("href")).toBe("https://offer.example.com/a");

    const impression = sent.find((e) => e.kind === "impression");
    expect(impression?.variantKey).toBe(VARIANT_KEY);
    expect(impression?.triggerKind).toBe("exit_intent");
    expect(impression?.impressionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(impression?.visitorHash).toMatch(/^[0-9a-f]{32}$/);
    // 🔴 送る URL にクエリとフラグメントを載せない(要件書 §6 裁定4)
    expect(impression?.pageUrl).toBe("https://lp.example.com/lp");
  });

  it("🔴 タブが隠れている間は表示に数えない(要件書 §4-7)", async () => {
    Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
    await show();
    expect(popup()?.querySelector(".panel"), "描いてはいる").not.toBeNull();
    expect(
      sent.filter((e) => e.kind === "impression"),
      "隠れているのに数えた",
    ).toEqual([]);
    // 🔴 見えていない表示で7日間の抑制を始めない(記録も残さない)
    expect(win.localStorage.getItem(`adpop:${SITE_KEY}:${POPUP_KEY}`)).toBeNull();
  });

  it("🔴 見出しに HTML を入れても、テキストとして出る(innerHTML を使わない)", async () => {
    await show({
      variants: [
        {
          key: VARIANT_KEY,
          kind: "text",
          weight: 100,
          content: { headline: "<img src=x onerror=alert(1)>", buttonLabel: "押す" },
          destinationUrl: "https://offer.example.com/a",
        },
      ],
    });
    const root = popup();
    expect(root?.querySelector("img"), "HTML として解釈された").toBeNull();
    expect(root?.querySelector(".headline")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("🔴 遷移先が https でないバリアントは、ローダが本体を呼ばない(1枚目)", async () => {
    await show({
      variants: [
        {
          key: VARIANT_KEY,
          kind: "text",
          weight: 100,
          content: {},
          destinationUrl: "javascript:alert(1)",
        },
      ],
    });
    expect(popup()).toBeNull();
    // ⚠ 発火は数える(条件は満たしている)。**表示だけが起きない。**
    expect(sent.map((e) => e.kind)).toEqual(["fire"]);
  });

  it.each([["javascript:alert(1)"], ["data:text/html,<script>x</script>"], ["http://offer.example.com/a"]])(
    "🔴 本体も描画の直前にもう一度確かめる(2枚目) —— %s",
    async (destinationUrl) => {
      /*
        🔴 **1枚目(ローダの `pickVariant`)だけを撃つと、2枚目は1ミリも測られない**
          (負例が2つの穴を同時に開ける形だと、後ろの守りは1ミリも測られない)。
          実測(2026-09-09): 本体側の検査を丸ごと消しても、
          上の it は緑のままだった。
        ✅ **ローダを通さずに注文を置いてから**本体を読み込む —— これは
          「DB を直接触られた」「ローダの検査をすり抜けた」に相当する状態。
          要件書 §5-3 が「**保存時と描画時の両方で検査する**」と言っているのは、まさにこの経路。
      */
      (win as unknown as Record<string, unknown>)[NAMESPACE] = {
        version: "test",
        request: {
          popupKey: POPUP_KEY,
          variant: { key: VARIANT_KEY, kind: "text", weight: 100, content: {}, destinationUrl },
          triggerKind: "exit_intent",
          visitorHash: "0".repeat(32),
          device: "desktop",
          pageUrl: "https://lp.example.com/lp",
          impressionId: "aaaaaaaa-0000-0000-0000-000000000001",
        },
        send: (event: EventPayload) => sent.push(event),
      } satisfies Bridge;

      await bootRuntime();

      expect(doc.querySelector("[data-adpop]"), `${destinationUrl} で描いてしまった`).toBeNull();
      expect(sent, "描いていないのにイベントを送った").toEqual([]);
    },
  );

  it("✅ 2枚目は https の遷移先を通す(締めすぎていないこと)", async () => {
    (win as unknown as Record<string, unknown>)[NAMESPACE] = {
      version: "test",
      request: {
        popupKey: POPUP_KEY,
        variant: {
          key: VARIANT_KEY,
          kind: "text",
          weight: 100,
          content: {},
          destinationUrl: "https://offer.example.com/a",
        },
        triggerKind: "exit_intent",
        visitorHash: "0".repeat(32),
        device: "desktop",
        pageUrl: "https://lp.example.com/lp",
        impressionId: "aaaaaaaa-0000-0000-0000-000000000002",
      },
      send: (event: EventPayload) => sent.push(event),
    } satisfies Bridge;

    await bootRuntime();

    expect(doc.querySelector("[data-adpop]")).not.toBeNull();
    expect(sent.map((e) => e.kind)).toEqual(["impression"]);
  });

  it.each([
    ["閉じるボタン", ".close", "button"],
    ["背景タップ", ".backdrop", "backdrop"],
  ])("%s で閉じ、理由が記録される", async (_label, selector, reason) => {
    await show();
    (popup()?.querySelector(selector) as HTMLElement).click();
    await flush();

    expect(sent.at(-1)?.kind).toBe("close");
    expect(sent.at(-1)?.closeReason).toBe(reason);
    expect(doc.querySelector("[data-adpop]"), "閉じたのに DOM に残っている").toBeNull();
  });

  it("Esc で閉じ、理由が記録される", async () => {
    await show();
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    await flush();

    expect(sent.at(-1)?.kind).toBe("close");
    expect(sent.at(-1)?.closeReason).toBe("esc");
    expect(doc.querySelector("[data-adpop]")).toBeNull();
  });

  it("パネルの中をクリックしても閉じない(背景タップと取り違えない)", async () => {
    await show();
    (popup()?.querySelector(".panel") as HTMLElement).click();
    await flush();

    expect(sent.filter((e) => e.kind === "close")).toEqual([]);
    expect(doc.querySelector("[data-adpop]")).not.toBeNull();
  });

  it("閉じるのは1回だけ数える(二重に送らない)", async () => {
    await show();
    (popup()?.querySelector(".close") as HTMLElement).click();
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    await flush();

    expect(sent.filter((e) => e.kind === "close")).toHaveLength(1);
  });

  it("クリックは押した数だけ記録する(CTR はダッシュボードで畳む)", async () => {
    await show();
    const cta = popup()?.querySelector(".cta") as HTMLElement;
    cta.click();
    cta.click();
    await flush();

    const clicks = sent.filter((e) => e.kind === "click");
    expect(clicks).toHaveLength(2);
    expect(clicks[0].impressionId).toBe(sent.find((e) => e.kind === "impression")?.impressionId);
  });

  it("a11y: ダイアログとして名前が付き、閉じるは記号だけに頼らない", async () => {
    await show();
    const root = popup() as ShadowRoot;
    const panel = root.querySelector(".panel") as HTMLElement;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    // 見出しが在るならそれが名前になる
    expect(panel.getAttribute("aria-labelledby")).toBe("adpop-headline");
    expect(root.getElementById("adpop-headline")?.textContent).toBe("まだ間に合います");
    // ✕ の意味は aria-label が持つ(記号だけに意味を持たせない)
    expect(root.querySelector(".close")?.getAttribute("aria-label")).toBe("閉じる");
    // 開いたら閉じるボタンにフォーカスが移る
    expect(root.activeElement).toBe(root.querySelector(".close"));
  });

  it("🔴 a11y: `aria-modal` を名乗る以上、Tab は背後の LP へ抜けない(提出前セルフレビュー)", async () => {
    /*
      🔴 宣言だけして Tab が抜けると、**支援技術には「背後は不活性」と伝えながら
        キーボードでは背後を操作できる** = 説明が実装より広い約束。
      ⚠ 閉じ込めているのは**閉じるボタンと誘導リンクの2つだけ**。
        フォーカスできる要素を足したら、実装側の一覧にも足す必要がある。
    */
    const outside = doc.createElement("button");
    outside.textContent = "LP のボタン";
    doc.body.appendChild(outside);
    await show();

    const root = popup() as ShadowRoot;
    const closeButton = root.querySelector(".close") as HTMLElement;
    const cta = root.querySelector(".cta") as HTMLElement;
    expect(root.activeElement).toBe(closeButton);

    const tab = (shiftKey = false) =>
      doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));

    tab();
    expect(root.activeElement, "閉じる → 誘導リンク").toBe(cta);
    tab();
    expect(root.activeElement, "末尾から先頭へ戻る(背後へ抜けない)").toBe(closeButton);
    tab(true);
    expect(root.activeElement, "Shift+Tab で末尾へ回る").toBe(cta);

    // ポップの外にフォーカスを置いても、次の Tab で中へ引き戻す
    outside.focus();
    tab();
    expect(root.activeElement, "外に出たフォーカスを引き戻していない").toBe(closeButton);
  });

  it("🔴 a11y: 閉じたら、開く前にフォーカスが在った場所へ戻る", async () => {
    const trigger = doc.createElement("button");
    trigger.textContent = "LP のボタン";
    doc.body.appendChild(trigger);
    trigger.focus();
    expect(doc.activeElement).toBe(trigger);

    await show();
    (popup()?.querySelector(".close") as HTMLElement).click();
    await flush();

    expect(doc.activeElement, "閉じたあとフォーカスが行方不明").toBe(trigger);
  });

  it("⚠ Tab / Escape 以外のキーには触らない(LP のショートカットを止めない)", async () => {
    await show();
    const event = new win.KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
    doc.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(doc.querySelector("[data-adpop]"), "関係ないキーで閉じた").not.toBeNull();
  });

  it("見出しが無いときは、ダイアログに aria-label が付く", async () => {
    await show({
      variants: [
        {
          key: VARIANT_KEY,
          kind: "text",
          weight: 100,
          content: {},
          destinationUrl: "https://offer.example.com/a",
        },
      ],
    });
    const panel = popup()?.querySelector(".panel") as HTMLElement;
    expect(panel.getAttribute("aria-labelledby")).toBeNull();
    expect(panel.getAttribute("aria-label")).toBe("お知らせ");
  });

  it("🔴 本体が2回読み込まれても、ポップは1つしか出ない", async () => {
    await show();
    await bootRuntime();

    expect(doc.querySelectorAll("[data-adpop]")).toHaveLength(1);
    expect(sent.filter((e) => e.kind === "impression")).toHaveLength(1);
  });

  it("🔴 ローダ抜きで本体だけ読み込まれても何もしない(fail-closed)", async () => {
    await bootRuntime();

    expect(doc.querySelector("[data-adpop]")).toBeNull();
    expect((win as unknown as Record<string, Bridge | undefined>)[NAMESPACE]).toBeUndefined();
  });
});

describe("画像型(§4-3 B・PR4a。2026-10-04 追補v2)", () => {
  const IMAGE_KEY = `images/${"e".repeat(32)}.png`;
  const IMAGE_URL = `${DELIVERY}/img/${"e".repeat(32)}.png`;

  /*
    🔴 jsdom は `resources` を有効にしていない限り `<img src>` を実際に取りに行かない
      (`load`/`error` のどちらも自然には発火しない)。**本体は画像の読み込みを待ってから描く**
      (Codex #8 1巡目 Blocker 2)ので、検査側で `HTMLImageElement.prototype.src` の setter を
      差し替え、`src` が設定された瞬間に `load`/`error` を**非同期(マイクロタスク)**で発火させる
      (ブラウザの実際の挙動=同期では発火しない、に合わせる)。`newDom()` が作る `win` ごとに
      差し替えるので、他のテストへは漏れない。
  */
  function stubImageLoad(outcome: "load" | "error"): void {
    const proto = win.HTMLImageElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
    Object.defineProperty(proto, "src", {
      configurable: true,
      get() {
        return this.getAttribute("src") ?? "";
      },
      set(value: string) {
        this.setAttribute("src", value);
        queueMicrotask(() => this.dispatchEvent(new win.Event(outcome)));
      },
    });
    void descriptor; // 元の descriptor は使わない(getAttribute 経由で十分)。型のためだけに参照。
  }

  async function showImage(content: Record<string, unknown>, imageOutcome: "load" | "error" = "load"): Promise<void> {
    stubImageLoad(imageOutcome);
    stubNetwork({
      config: configBody({
        variants: [
          {
            key: VARIANT_KEY,
            kind: "image",
            weight: 100,
            content,
            destinationUrl: "https://offer.example.com/a",
          },
        ],
      }),
    });
    installTag();
    await bootLoader();
    exitIntent();
    await flush();
    await bootRuntime();
    await flush(); // 画像の読み込み(マイクロタスク)が解決してから DOM 挿入が走るのを待つ
  }

  it("✅ 画像だけのバナー(ボタン文言が空)。画像全体が1つのリンクで、閉じるボタンは独立している", async () => {
    await showImage({ headline: "", body: "", buttonLabel: "", imageAlt: "秋の新作キャンペーン", imageKey: IMAGE_KEY });

    const root = popup() as ShadowRoot;
    const link = root.querySelector(".image-link") as HTMLAnchorElement;
    expect(link, "画像リンクが無い").not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://offer.example.com/a");
    // 🔴 名前=alt。画像の説明がそのままリンクの名前になる
    expect(link.getAttribute("aria-label")).toBe("秋の新作キャンペーン");
    expect(link.querySelector("img")?.getAttribute("src")).toBe(IMAGE_URL);
    // ⚠ 画像自身の alt は空(アクセシブルネームは <a> の aria-label が持つ。1つの画像に2つの名前を付けない)
    expect(link.querySelector("img")?.getAttribute("alt")).toBe("");
    // ボタン文言が空なので、フッター(見出し・ボタン)は出ない
    expect(root.querySelector(".footer")).toBeNull();
    expect(root.querySelector(".cta")).toBeNull();
    // 閉じるボタンは独立した要素で、画像リンクの入れ子ではない
    const close = root.querySelector(".close-image") as HTMLElement;
    expect(close, "閉じるボタンが無い").not.toBeNull();
    expect(link.contains(close)).toBe(false);
    expect(close.getAttribute("aria-label")).toBe("閉じる");
    // ダイアログの名前は画像の説明(見出しが無いので)
    expect(root.querySelector(".panel")?.getAttribute("aria-label")).toBe("秋の新作キャンペーン");
  });

  it("✅ 画像+ボタン。画像リンクとボタンは同じ遷移先を指す別々の <a>(入れ子にしない)", async () => {
    await showImage({ headline: "", body: "", buttonLabel: "友だち追加", imageAlt: "", imageKey: IMAGE_KEY });

    const root = popup() as ShadowRoot;
    const link = root.querySelector(".image-link") as HTMLAnchorElement;
    const cta = root.querySelector(".footer .cta") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://offer.example.com/a");
    expect(cta.getAttribute("href")).toBe("https://offer.example.com/a");
    expect(link.contains(cta)).toBe(false);
    expect(cta.textContent).toBe("友だち追加");
    // imageAlt が空でもボタン文言があるので、画像リンクの名前はボタン文言に落ちる(空にはしない)
    expect(link.getAttribute("aria-label")).toBe("友だち追加");
  });

  it("🔴 画像と誘導リンク(ボタン)のどちらを押しても click が記録される", async () => {
    await showImage({ headline: "", body: "", buttonLabel: "友だち追加", imageAlt: "", imageKey: IMAGE_KEY });
    const root = popup() as ShadowRoot;
    (root.querySelector(".image-link") as HTMLElement).click();
    (root.querySelector(".footer .cta") as HTMLElement).click();
    await flush();

    const clicks = sent.filter((e) => e.kind === "click");
    expect(clicks).toHaveLength(2);
  });

  it("🔴 `imageKey` の形が崩れている(2枚目の関門)と、何も描かない・表示も数えない", async () => {
    /*
      🔴 配信(DELIVERABLE_VARIANT)は imageKey が入った画像型だけを配るが、
        本体はそれを信用せず**描画の直前にもう一度確かめる**(要件書 §5-3 と同じ考え方)。
        ローダを通さずに `bridge.request` を直接書き替えた状態と同じ経路で撃つ。
    */
    (win as unknown as Record<string, unknown>)[NAMESPACE] = {
      version: "test",
      request: {
        popupKey: POPUP_KEY,
        variant: {
          key: VARIANT_KEY,
          kind: "image",
          weight: 100,
          content: { imageKey: "../../etc/passwd" },
          destinationUrl: "https://offer.example.com/a",
        },
        triggerKind: "exit_intent",
        visitorHash: "0".repeat(32),
        device: "desktop",
        pageUrl: "https://lp.example.com/lp",
        impressionId: "aaaaaaaa-0000-0000-0000-000000000003",
        deliveryOrigin: DELIVERY,
      },
      send: (event: EventPayload) => sent.push(event),
    } satisfies Bridge;

    await bootRuntime();

    expect(doc.querySelector("[data-adpop]"), "崩れた imageKey なのに描いてしまった").toBeNull();
    expect(sent, "描いていないのにイベントを送った").toEqual([]);
  });

  it("🔴 `deliveryOrigin` が欠けていると、同じく描かない(配信ホストが無ければ画像 URL を組めない)", async () => {
    (win as unknown as Record<string, unknown>)[NAMESPACE] = {
      version: "test",
      request: {
        popupKey: POPUP_KEY,
        variant: {
          key: VARIANT_KEY,
          kind: "image",
          weight: 100,
          content: { imageKey: IMAGE_KEY },
          destinationUrl: "https://offer.example.com/a",
        },
        triggerKind: "exit_intent",
        visitorHash: "0".repeat(32),
        device: "desktop",
        pageUrl: "https://lp.example.com/lp",
        impressionId: "aaaaaaaa-0000-0000-0000-000000000004",
        // ⚠ deliveryOrigin を渡さない
      },
      send: (event: EventPayload) => sent.push(event),
    } satisfies Bridge;

    await bootRuntime();

    expect(doc.querySelector("[data-adpop]")).toBeNull();
  });

  it("a11y: Tab は 閉じる → 画像リンク → ボタン → (末尾から戻る)の順に閉じ込める", async () => {
    await showImage({ headline: "", body: "", buttonLabel: "友だち追加", imageAlt: "", imageKey: IMAGE_KEY });
    const root = popup() as ShadowRoot;
    const close = root.querySelector(".close-image") as HTMLElement;
    const link = root.querySelector(".image-link") as HTMLElement;
    const cta = root.querySelector(".footer .cta") as HTMLElement;
    expect(root.activeElement, "開いたら閉じるボタンにフォーカスが移る").toBe(close);

    const tab = () => doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    tab();
    expect(root.activeElement).toBe(link);
    tab();
    expect(root.activeElement).toBe(cta);
    tab();
    expect(root.activeElement, "末尾から先頭へ戻る(背後へ抜けない)").toBe(close);
  });

  it("Esc で閉じる(画像型でも§4-3の共通)", async () => {
    await showImage({ headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY });
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    await flush();

    expect(doc.querySelector("[data-adpop]")).toBeNull();
    expect(sent.at(-1)?.kind).toBe("close");
    expect(sent.at(-1)?.closeReason).toBe("esc");
  });

  it("背景タップでも閉じる(§4-3の共通)", async () => {
    await showImage({ headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY });
    const root = popup() as ShadowRoot;
    (root.querySelector(".backdrop") as HTMLElement).click();
    await flush();

    expect(doc.querySelector("[data-adpop]")).toBeNull();
    expect(sent.at(-1)?.closeReason).toBe("backdrop");
  });

  it("🔴 a11y: 画像の読み込みを待っている間にフォーカスを移していたら、閉じたときはその新しい場所へ戻る(Codex #8 2巡目 Should fix)", async () => {
    /*
      再現: exit intent が発火した時点(トリガー時点)では要素Aにフォーカスがあったが、画像の読み込みを
      待っている最大8秒の間に、利用者が(ポップとは無関係に)LP の別の要素Bへフォーカスを移した。
      ポップが実際に挿し込まれる(=読み込みが終わった)のはその後なので、**「開く前」はBを指すべき**で、
      閉じたときはBへ戻る(トリガー時点のAへ戻ってしまうと、利用者が後から動かした先を見失う)。
    */
    const elementA = doc.createElement("button");
    elementA.textContent = "A(発火時点の要素)";
    doc.body.appendChild(elementA);
    elementA.focus();
    expect(doc.activeElement, "前提: 発火時点では A にフォーカス").toBe(elementA);

    // ⚠ 本体がまだ DOM に挿していない <img> を直接つかむため、`doc.createElement` を捕まえる
    const createdImages: HTMLImageElement[] = [];
    const originalCreateElement = doc.createElement.bind(doc);
    (doc as unknown as { createElement: typeof doc.createElement }).createElement = ((tag: string) => {
      const el = originalCreateElement(tag as keyof HTMLElementTagNameMap);
      if (tag === "img") createdImages.push(el as HTMLImageElement);
      return el;
    }) as typeof doc.createElement;

    stubNetwork({
      config: configBody({
        variants: [
          {
            key: VARIANT_KEY,
            kind: "image",
            weight: 100,
            content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY },
            destinationUrl: "https://offer.example.com/a",
          },
        ],
      }),
    });
    installTag();
    await bootLoader();
    exitIntent();
    await flush();
    startRuntime(win, doc);
    await flush();

    expect(createdImages, "<img> が作られていない(この検査の前提が壊れている)").toHaveLength(1);
    expect(doc.querySelector("[data-adpop]"), "読み込みを待っている間にもう描いてしまった").toBeNull();

    // 読み込みを待っている間に、利用者が要素Bへフォーカスを移す
    const elementB = doc.createElement("button");
    elementB.textContent = "B(待っている間に移した先)";
    doc.body.appendChild(elementB);
    elementB.focus();
    expect(doc.activeElement).toBe(elementB);

    // 画像の読み込みが終わる
    createdImages[0].dispatchEvent(new win.Event("load"));
    await flush();
    expect(doc.querySelector("[data-adpop]"), "読み込みが終わったのに描いていない").not.toBeNull();

    (popup()?.querySelector(".close-image") as HTMLElement).click();
    await flush();

    expect(doc.activeElement, "発火時点の A へ戻ってしまった(B へ戻るべき)").toBe(elementB);
  });

  describe("🔴 画像の読み込みに失敗したら、何も出さない(Codex #8 1巡目 Blocker 2)", () => {
    /*
      再現(Blocker 2 の原文どおり): LP が旧 imageKey を含む config を取得済みの状態で、管理側が
      画像を差し替え・削除して旧キーが `/img/<old-key>` で 404 になってから exit intent が発火する。
      本体は**画像の読み込みが成功してから** DOM 挿入・`shown`・impression を成立させる。
      失敗(404 相当のエラー)・タイムアウトのどちらでも、何も描かず計測も送らない
      (`fire` は発火条件を満たした時点で既に送られているので、それだけは残る)。
    */
    it("画像が404(error)— DOM・shown・impression のどれも成立しない", async () => {
      await showImage({ headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY }, "error");

      expect(doc.querySelector("[data-adpop]"), "読み込み失敗なのに描いてしまった").toBeNull();
      expect(sent.map((e) => e.kind)).toEqual(["fire"]);
      // bridge.shown が立っていないことも確認する(ローダ側が「出せなかった」と判定できる)
      const bridge = (win as unknown as Record<string, { shown?: boolean }>)[NAMESPACE];
      expect(bridge?.shown).not.toBe(true);
    });

    it(`画像の読み込みが ${IMAGE_LOAD_TIMEOUT_MS}ms を超えてもタイムアウトし、何も描かない`, async () => {
      vi.useFakeTimers();
      try {
        stubNetwork({
          config: configBody({
            variants: [
              {
                key: VARIANT_KEY,
                kind: "image",
                weight: 100,
                content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY },
                destinationUrl: "https://offer.example.com/a",
              },
            ],
          }),
        });
        installTag();
        startAdpop(win, doc);
        await vi.advanceTimersByTimeAsync(0); // 設定の取得(fetch の Promise)を解決させる
        exitIntent();
        await vi.advanceTimersByTimeAsync(0); // fire → 本体(<script>)の挿入まで
        startRuntime(win, doc); // 本体が読み込まれた状況を作る(画像の `load`/`error` は一度も発火させない)
        await vi.advanceTimersByTimeAsync(IMAGE_LOAD_TIMEOUT_MS + 1000); // 上限を越える

        expect(doc.querySelector("[data-adpop]"), "タイムアウトしたのに描いてしまった").toBeNull();
        expect(sent.filter((e) => e.kind === "impression")).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("🔴 画像を待っている間に本体がもう一度読み込まれても、ポップは1つしか出ない(Codex #8 2巡目 Blocker)", async () => {
      // ⚠ 本体がまだ DOM に挿していない <img> を直接つかむため、`doc.createElement` を捕まえる
      const createdImages: HTMLImageElement[] = [];
      const originalCreateElement = doc.createElement.bind(doc);
      (doc as unknown as { createElement: typeof doc.createElement }).createElement = ((tag: string) => {
        const el = originalCreateElement(tag as keyof HTMLElementTagNameMap);
        if (tag === "img") createdImages.push(el as HTMLImageElement);
        return el;
      }) as typeof doc.createElement;

      stubNetwork({
        config: configBody({
          variants: [
            {
              key: VARIANT_KEY,
              kind: "image",
              weight: 100,
              content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY },
              destinationUrl: "https://offer.example.com/a",
            },
          ],
        }),
      });
      installTag();
      await bootLoader();
      exitIntent();
      await flush();

      /*
        🔴 **画像の `load` を保留したまま、`startRuntime()` を2回呼ぶ**(Codex 原文どおりの再現)。
          以前は `drawing` が `startRuntime()` のローカル変数だったため、1回目が画像を待っている間に
          2回目を呼ぶと、2回目は**別の `drawing = false`** を見て、同じ画像をもう一度読み込みに行けた
          (両方成功すると DOM が2つ・impression も2件になっていた)。
      */
      startRuntime(win, doc);
      startRuntime(win, doc);
      await flush();

      // 🔴 <img> が1つしか作られていない(2つ目の startRuntime が bridge.drawing を見て何もしなかった)
      expect(createdImages, "<img> が複数作られた = 二重に読み込みに行った").toHaveLength(1);

      // 両方(実際には1つだけ存在する)の <img> に load を送っても、出来上がるポップは1つだけ
      for (const img of createdImages) img.dispatchEvent(new win.Event("load"));
      await flush();

      expect(doc.querySelectorAll("[data-adpop]"), "ポップが複数出た").toHaveLength(1);
      expect(sent.filter((e) => e.kind === "impression"), "impression が複数送られた").toHaveLength(1);
    });

    it("🔴 タイムアウトの後に load が遅れて届いても、DOM・shown・impression のどれも成立しない(Codex #8 2巡目 Should fix)", async () => {
      // ⚠ 本体がまだ DOM に挿していない <img> を直接つかむため、`doc.createElement` を捕まえる
      const createdImages: HTMLImageElement[] = [];
      const originalCreateElement = doc.createElement.bind(doc);
      (doc as unknown as { createElement: typeof doc.createElement }).createElement = ((tag: string) => {
        const el = originalCreateElement(tag as keyof HTMLElementTagNameMap);
        if (tag === "img") createdImages.push(el as HTMLImageElement);
        return el;
      }) as typeof doc.createElement;

      vi.useFakeTimers();
      try {
        stubNetwork({
          config: configBody({
            variants: [
              {
                key: VARIANT_KEY,
                kind: "image",
                weight: 100,
                content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY },
                destinationUrl: "https://offer.example.com/a",
              },
            ],
          }),
        });
        installTag();
        startAdpop(win, doc);
        await vi.advanceTimersByTimeAsync(0);
        exitIntent();
        await vi.advanceTimersByTimeAsync(0);
        startRuntime(win, doc);
        await vi.advanceTimersByTimeAsync(IMAGE_LOAD_TIMEOUT_MS + 1000); // ここで一度タイムアウトが確定している

        expect(createdImages, "<img> が1つも作られていない(この検査の前提が壊れている)").toHaveLength(1);
        // 🔴 遅れて届いた load(低速回線で、タイムアウト扱いにした後にブラウザが読み込みを終えた場合を模す)
        createdImages[0].dispatchEvent(new win.Event("load"));
        await vi.advanceTimersByTimeAsync(0);

        expect(doc.querySelector("[data-adpop]"), "遅れて届いた load で描いてしまった").toBeNull();
        expect(sent.filter((e) => e.kind === "impression")).toEqual([]);
        const bridge = (win as unknown as Record<string, { shown?: boolean }>)[NAMESPACE];
        expect(bridge?.shown, "遅れて届いた load で shown が立った").not.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    /*
      🔴 **PR #8 最終巡 Should fix(テストだけ・2026-10-04 PR5a で追加)**:
        `bridge.drawing` は失敗の種類(画像の失敗・タイムアウト・`draw()` 内の同期の例外)に関わらず
        必ず `false` に戻り、**そのあとの `bridge.render()` 呼び出しでは再び描ける**ことを固定する。
        ⚠ `runtime.ts` 側の実装は変えていない(既に `.then(resolve, reject)` の両方が
        `bridge.drawing = false` を立てる形になっている)。ここまでは実装済みの振る舞いを**初めてテストで撃つ**。
    */
    it("🔴 画像エラーの後、drawing は false に戻り、次の bridge.render() では描ける", async () => {
      await showImage({ headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY }, "error");
      const bridge = (win as unknown as Record<string, { drawing?: boolean; shown?: boolean; render?: () => void }>)[
        NAMESPACE
      ];
      expect(doc.querySelector("[data-adpop]"), "前提: まだ描かれていない").toBeNull();
      expect(bridge.drawing, "画像エラーの後も drawing が true のまま(2回目の render が無視される)").not.toBe(true);
      expect(bridge.shown).not.toBe(true);

      // 次の挑戦では画像が読み込める状況にして、同じ bridge の render() をもう一度呼ぶ
      stubImageLoad("load");
      bridge.render?.();
      await flush();

      expect(doc.querySelector("[data-adpop]"), "drawing が false に戻ったはずなのに、次の render() で描けない").not.toBeNull();
      expect(bridge.shown).toBe(true);
    });

    it(`タイムアウトの後、drawing は false に戻り、次の bridge.render() では描ける`, async () => {
      vi.useFakeTimers();
      try {
        stubNetwork({
          config: configBody({
            variants: [
              {
                key: VARIANT_KEY,
                kind: "image",
                weight: 100,
                content: { headline: "", body: "", buttonLabel: "", imageAlt: "説明", imageKey: IMAGE_KEY },
                destinationUrl: "https://offer.example.com/a",
              },
            ],
          }),
        });
        installTag();
        startAdpop(win, doc);
        await vi.advanceTimersByTimeAsync(0);
        exitIntent();
        await vi.advanceTimersByTimeAsync(0);
        startRuntime(win, doc);
        await vi.advanceTimersByTimeAsync(IMAGE_LOAD_TIMEOUT_MS + 1000); // タイムアウトが確定する

        const bridge = (win as unknown as Record<string, { drawing?: boolean; shown?: boolean; render?: () => void }>)[
          NAMESPACE
        ];
        expect(doc.querySelector("[data-adpop]"), "前提: まだ描かれていない").toBeNull();
        expect(bridge.drawing, "タイムアウトの後も drawing が true のまま").not.toBe(true);

        // 次の挑戦に備えて実タイマーへ戻し、画像が読み込める状況で render() をもう一度呼ぶ
        vi.useRealTimers();
        stubImageLoad("load");
        bridge.render?.();
        await flush();

        expect(doc.querySelector("[data-adpop]"), "drawing が false に戻ったはずなのに、次の render() で描けない").not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("🔴 draw() 内の同期の例外(不正な imageKey)の後、drawing は false に戻り、次の bridge.render() では描ける", async () => {
      /*
        `isImage && imageUrl === null` は `await` の前(同期)で throw する経路
        (= Promise の reject であって、画像の `load`/`error` イベントを経由しない失敗)。
        ローダを通さずに `bridge` を直接書き替え、この経路だけを単独で撃つ(embed-flow.test.ts の
        「2枚目の関門」と同じ手口)。
      */
      const brokenRequest = {
        popupKey: POPUP_KEY,
        variant: {
          key: VARIANT_KEY,
          kind: "image",
          weight: 100,
          content: { imageKey: "../../etc/passwd" },
          destinationUrl: "https://offer.example.com/a",
        },
        triggerKind: "exit_intent" as const,
        visitorHash: "0".repeat(32),
        device: "desktop" as const,
        pageUrl: "https://lp.example.com/lp",
        impressionId: "aaaaaaaa-0000-0000-0000-000000000005",
        deliveryOrigin: DELIVERY,
      };
      (win as unknown as Record<string, unknown>)[NAMESPACE] = {
        version: "test",
        request: brokenRequest,
        send: (event: EventPayload) => sent.push(event),
      } satisfies Bridge;

      await bootRuntime();

      const bridge = (win as unknown as Record<string, Bridge>)[NAMESPACE];
      expect(doc.querySelector("[data-adpop]"), "前提: 不正な imageKey では描かれない").toBeNull();
      expect(bridge.drawing, "draw() 内の例外の後も drawing が true のまま").not.toBe(true);
      expect(bridge.shown).not.toBe(true);

      // 正しい imageKey に差し替えて、同じ bridge の render() をもう一度呼ぶ
      stubImageLoad("load");
      bridge.request = { ...brokenRequest, variant: { ...brokenRequest.variant, content: { imageKey: IMAGE_KEY } } };
      bridge.render?.();
      await flush();

      expect(doc.querySelector("[data-adpop]"), "drawing が false に戻ったはずなのに、次の render() で描けない").not.toBeNull();
    });
  });
});
