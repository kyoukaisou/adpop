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
import { startAdpop } from "../packages/embed/src/loader";
import { startRuntime } from "../packages/embed/src/runtime";

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

describe("トリガ(PR2 は ①戻る と ⑥exit intent の2つだけ)", () => {
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

  it("① 戻るボタンで発火する(履歴に1枚挟んで popstate を見る)", async () => {
    stubNetwork();
    installTag();
    const pushState = vi.spyOn(win.history, "pushState");
    await bootLoader();

    expect(pushState).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire"]);
    expect(sent[0].triggerKind).toBe("back");
  });

  it("🔴 1ページの表示は最大1回(最初に条件を満たしたトリガだけを記録する)", async () => {
    stubNetwork();
    installTag();
    await bootLoader();

    exitIntent();
    win.dispatchEvent(new win.PopStateEvent("popstate"));
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

  it("🔴 最短表示待ちの間は、履歴に1枚も積まない(積むと、その間の「戻る」が食われる)", async () => {
    /*
      🔴 **元の穴**(Codex 1巡目 sol Medium): 読み込み直後に履歴を積んでいたので、
        **待ちの間の「戻る」がその1枚を食い**、`fire()` は早すぎるので何もせず、
        **もう積み直さない**ので**以後まったく発火しなくなっていた**。
      ✅ 積むのを待ちが明けてからにした。待ちの間の「戻る」は**普通の離脱**として通す。
    */
    const pushState = vi.spyOn(win.history, "pushState");
    stubNetwork({ config: configBody({ minDisplayDelaySeconds: 30 }) });
    installTag();
    await bootLoader();

    expect(pushState, "待ちの間に履歴を積んでいる").not.toHaveBeenCalled();

    // 待ちの間の「戻る」は、こちらの listener に届かない(積んでいないので何も起きない)
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();
    expect(sent).toEqual([]);
  });

  it("✅ 待ちが明けたら履歴を積み、そこからは戻るで発火する", async () => {
    vi.useFakeTimers();
    try {
      const pushState = vi.spyOn(win.history, "pushState");
      stubNetwork({ config: configBody({ minDisplayDelaySeconds: 3 }) });
      installTag();
      startAdpop(win, doc);
      await vi.advanceTimersByTimeAsync(0);
      expect(pushState).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3000);
      expect(pushState, "待ちが明けても履歴を積んでいない").toHaveBeenCalledTimes(1);

      win.dispatchEvent(new win.PopStateEvent("popstate"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.map((e) => e.kind)).toEqual(["fire"]);
      expect(sent[0].triggerKind).toBe("back");
    } finally {
      vi.useRealTimers();
    }
  });

  it("🔴 出さないと決めたら、利用者の「戻る」を通し直す(1回吸収したままにしない)", async () => {
    /*
      🔴 **元の穴**(Codex 1巡目 Astra Medium): 抑制された・出せるバリアントが無い —— どの場合でも
        積んだ1枚が消費され、**利用者は「戻る」を押したのに何も起きなかった**。
        これは「**配信が落ちてもポップが出ないだけ**」という約束(要件書 §5-2)を破っている。
      ✅ 出さないと決めたら `history.back()` で意図を通し直す。
      ⚠ 先に listener を外してから呼ぶ(外さないと popstate が再入して**履歴を遡り続ける**)。
    */
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
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

    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire", "suppressed"]);
    expect(back, "戻るを吸収したままにした").toHaveBeenCalledTimes(1);

    // ⚠ 再入していない(listener を外してから呼んでいる)
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();
    expect(back, "popstate が再入して履歴を遡り続けている").toHaveBeenCalledTimes(1);
  });

  it("🔴🔴 本体の取得に失敗したら、「戻る」を通し直す(Codex 2巡目 Blocker 3)", async () => {
    /*
      🔴 **元の穴**: `fire()` が**本体の読み込みが成功する前に**「出す」と答えていたので、
        **CDN 障害・CSP・広告ブロッカーで本体が落ちたとき**、
        **ポップも出ないのに「戻る」だけ奪われていた。**
        = 「**配信が落ちてもポップが出ないだけ**」という約束(要件書 §5-2)を破っている。
      ✅ 「出せなかった」を `loadRuntime` から呼び出し側へ返し、そこで `history.back()` する。
    */
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
    stubNetwork();
    installTag();
    await bootLoader();

    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();

    // ここまでは「出す」と決まっている(本体を取りに行った)
    const script = doc.querySelector(`script[src="${DELIVERY}/embed/adpop.js"]`);
    expect(script, "本体を取りに行っていない").not.toBeNull();
    expect(back, "まだ通し直してはいけない").not.toHaveBeenCalled();

    // 🔴 本体の取得が失敗する(CDN 障害 / CSP / 広告ブロッカー)
    script!.dispatchEvent(new win.Event("error"));
    await flush();

    expect(doc.querySelector("[data-adpop]"), "出ていないこと").toBeNull();
    expect(back, "本体が落ちたのに「戻る」を吸収したまま").toHaveBeenCalledTimes(1);
  });

  it("🔴 本体は読み込めたのに描かれなかった場合も、「戻る」を通し直す", async () => {
    /*
      ⚠ **読み込みの成否ではなく、描かれたかどうかで決める。**
        `onload` でも「出せなかった」を判定する(bridge の取り違え等で描けない場合)。
    */
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
    stubNetwork();
    installTag();
    await bootLoader();
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();

    const script = doc.querySelector(`script[src="${DELIVERY}/embed/adpop.js"]`)!;
    // 本体を動かさないまま onload だけ起こす
    script.dispatchEvent(new win.Event("load"));
    await flush();

    expect(doc.querySelector("[data-adpop]")).toBeNull();
    expect(back, "描かれていないのに「戻る」を吸収したまま").toHaveBeenCalledTimes(1);
  });

  it("✅ 本体が描けたら、`onload` が来ても「戻る」を通し直さない", async () => {
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
    stubNetwork();
    installTag();
    await bootLoader();
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();
    await bootRuntime();

    expect(doc.querySelector("[data-adpop]"), "出ていない").not.toBeNull();
    doc.querySelector(`script[src="${DELIVERY}/embed/adpop.js"]`)!.dispatchEvent(new win.Event("load"));
    await flush();

    expect(back, "出せているのに戻してしまった").not.toHaveBeenCalled();
  });

  it("🔴 通し直しは1回だけ(同期の判定と本体の失敗が二重に走らない)", async () => {
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
    stubNetwork();
    installTag();
    await bootLoader();
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();

    const script = doc.querySelector(`script[src="${DELIVERY}/embed/adpop.js"]`)!;
    script.dispatchEvent(new win.Event("error"));
    script.dispatchEvent(new win.Event("load"));
    script.dispatchEvent(new win.Event("error"));
    await flush();

    expect(back).toHaveBeenCalledTimes(1);
  });

  it("⚠ exit intent では本体が落ちても履歴に触らない(触っていないので戻すものが無い)", async () => {
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
    stubNetwork({ config: configBody({ triggers: [{ kind: "exit_intent", threshold: null }] }) });
    installTag();
    await bootLoader();

    exitIntent();
    await flush();
    doc.querySelector(`script[src="${DELIVERY}/embed/adpop.js"]`)!.dispatchEvent(new win.Event("error"));
    await flush();

    expect(back, "履歴を触っていないのに戻した").not.toHaveBeenCalled();
  });

  it("✅ 出すと決めたときは、戻るを通し直さない(ポップを見せる)", async () => {
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
    stubNetwork();
    installTag();
    await bootLoader();

    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();

    expect(sent.map((e) => e.kind)).toEqual(["fire"]);
    expect(back).not.toHaveBeenCalled();
  });

  it("🔴 別のトリガで既に出した後の「戻る」は、そのまま通す", async () => {
    const back = vi.spyOn(win.history, "back").mockImplementation(() => {});
    stubNetwork();
    installTag();
    await bootLoader();

    exitIntent();
    await flush();
    expect(sent.map((e) => e.kind)).toEqual(["fire"]);

    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();

    expect(sent.filter((e) => e.kind === "fire"), "2回目の発火を数えた").toHaveLength(1);
    expect(back, "既に出した後の戻るを吸収した").toHaveBeenCalledTimes(1);
  });

  it("🔴 タッチ端末では exit intent を**登録しない**(誤爆源を作らない)", async () => {
    (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
    stubNetwork();
    installTag();
    await bootLoader();

    exitIntent();
    await flush();
    expect(sent).toEqual([]);

    // ⚠ 端末の2値は「スマホ」側になっている(要件書 §5-4)
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();
    expect(sent[0].device).toBe("mobile");
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

    // ① 戻るは端末を問わず動く(要件書 §4-2)
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    await flush();
    expect(sent.map((e) => e.kind)).toEqual(["fire"]);
    expect(sent[0].device).toBe("mobile");
  });

  it("⚠ PR2 が知らないトリガ(スクロール等)は無視する = 何も起きない", async () => {
    stubNetwork({ config: configBody({ triggers: [{ kind: "scroll", threshold: 50 }] }) });
    installTag();
    await bootLoader();

    win.dispatchEvent(new win.Event("scroll"));
    exitIntent();
    win.dispatchEvent(new win.PopStateEvent("popstate"));
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
