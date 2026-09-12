// @vitest-environment jsdom
//
// 🔴 **「埋め込み先の LP を1ミリも壊さない」を、出荷する成果物そのもので撃つ。**
//
// ここが測るのは要件書 §5-2 の4つ:
//   ① **描画を止めない**(`document.write` / 同期 XHR を1度も呼ばない)
//   ② **エラーを外に漏らさない**(何が起きても例外が外へ出ない・未捕捉の rejection を作らない)
//   ③ **グローバルを汚さない**(`window` に生やす鍵は1つ・プロトタイプを1つも触らない)
//   ④ **配信が落ちても LP は無傷**(fail-closed = ポップが出ないだけ)
//
// ⚠ **ソースではなく `esbuild` が束ねた出力を実行して測る。**
//   ソースを読んで「そう書いていない」を確かめるのは、**書き方の話**であって
//   **実際に何を呼ぶか**ではない(2026-09-08 に、まさにその抜け方を2つ踏んでいる)。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLES } from "../scripts/bundle-size.mjs";
/*
  ⚠ **`packages/embed/src/loader` を import しない。**
    あれは読み込んだ時点で**自分で起動する**(本番と同じ経路)ので、
    この束の「グローバルを汚さない」の**基準になる window が、測る前から汚れる**。
    → 定数は副作用の無い `./bridge` から取る。
*/
import { NAMESPACE, RUNTIME_PATH } from "../packages/embed/src/bridge";

const SITE_KEY = "0123456789abcdef0123456789abcdef";

/**
 * 🔴 **この束を読み込んだ時点の window の鍵**。
 *   ⚠ **各テストの直前に撮ってはいけない** —— 前のテストが生やした鍵が
 *   「元から在ったもの」に見え、**汚染を1つも検出できなくなる**(2026-09-09 に実際にそうなっていた:
 *   ローダに `window.adpopDebug = 1` を足す変異を当てても、この束は緑のままだった)。
 */
const PRISTINE_KEYS = new Set(Object.getOwnPropertyNames(window));

/** 設定の応答。⚠ **発火・描画まで通す**ために、実際に出せる中身にする。 */
const CONFIG_BODY = JSON.stringify({
  v: 1,
  popup: {
    key: "p".repeat(32),
    minDisplayDelaySeconds: 0,
    /*
      🔴 **頻度制御を効かせない値にしてある**(2026-09-12 に踏んだ)。
        この束は jsdom がファイルで1つなので、**前のテストが描いたポップの「表示」記録が、
        `beforeEach` の後から書き込まれる** ——
        表示を数えるのは `requestAnimationFrame` の中(約16ms 後)なので、
        **テストが終わってから走る**ことがある。その書き込みが `sessionStorage` に載ると、
        **次のテストのローダが「セッション内1回」で抑制され、発火しない。**
        実測: 全束を並列で走らせると6〜8回に1回ほど「本体への注文が載らない」で落ちた。
      ⚠ **待ち方の問題ではなかった**(5秒待っても載らない)。**前のテストの非同期の後始末**が原因。
      ✅ ここで見たいのは「**描くところまで通したときに、周りを汚さないか**」なので、
        頻度制御は**効かない値**にして、前のテストの記録に左右されないようにする。
    */
    frequency: { suppressDays: 0, sessionImpressions: 9999, postConversionDays: 0 },
    /*
      ⚠ **`back` も有効として返す。** DB の enum も `popup_triggers` の行も残してあるので、
        サーバーは `back` を有効として返しうる。**それでも埋め込み側は履歴に触らない**、が見たいこと。
    */
    triggers: [
      { kind: "back", threshold: null },
      { kind: "exit_intent", threshold: null },
    ],
    variants: [
      {
        key: "v".repeat(32),
        kind: "text",
        weight: 100,
        content: { headline: "まだ間に合います", buttonLabel: "確認する" },
        destinationUrl: "https://offer.example.com/a",
      },
    ],
  },
});

type Trap = { calls: string[] };

/** 束ねた出力を、この jsdom の window で実行する。 */
function evaluateBundle(code: string): void {
  // ⚠ `new Function` の `this` は globalThis(= jsdom の window)。
  //   本番の `<script>` と同じく、**グローバルスコープで走る**形にする。
  new Function(code)();
}

function installTag(): void {
  const script = document.createElement("script");
  script.setAttribute("data-adpop-site", SITE_KEY);
  script.src = "https://delivery.example.com/embed/t.js";
  document.head.appendChild(script);
}

/*
  ══════════════════════════════════════════════════════════════════════════
  グローバルの指紋 —— **名前だけでなく、中身の同一性まで**
  ══════════════════════════════════════════════════════════════════════════
  🔴 **`Object.keys` では足りない**(Codex 1巡目 sol Medium)。3つ取りこぼす:
    ① **非 enumerable** な own property(`Object.defineProperty` で足されたもの)
    ② **既存メンバーの差し替え**(`window.fetch = ...` / `History.prototype.pushState = ...`)
    ③ **プロトタイプのメソッドの差し替え**(名前の一覧は1文字も変わらない)
  ✅ `getOwnPropertyNames` + **記述子の同一性**(データなら `value`、アクセサなら `get`/`set`)で撮る。
  ⚠ **ゲッタを呼ばない**(`getOwnPropertyDescriptor` は呼ばない)。呼ぶと副作用が出る窓のプロパティがある。
*/
type Fingerprint = { names: string[]; slots: Map<string, unknown> };

const WATCHED_PROTOTYPES: Array<[string, object]> = [
  ["Object", Object.prototype],
  ["Array", Array.prototype],
  ["Function", Function.prototype],
  ["String", String.prototype],
  ["EventTarget", EventTarget.prototype],
  ["Document", Document.prototype],
  ["Element", Element.prototype],
  ["History", History.prototype],
  ["Storage", Storage.prototype],
];

function fingerprintOf(target: object): Fingerprint {
  const names = Object.getOwnPropertyNames(target).sort();
  const slots = new Map<string, unknown>();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor) continue;
    // アクセサはゲッタを呼ばずに関数の同一性だけ見る
    slots.set(name, "value" in descriptor ? descriptor.value : [descriptor.get, descriptor.set]);
  }
  return { names, slots };
}

/** @returns 変わったところ(空なら1つも触っていない)。 */
function diffFingerprint(before: Fingerprint, after: Fingerprint, label: string): string[] {
  const changes: string[] = [];
  for (const name of after.names) {
    if (!before.slots.has(name)) {
      changes.push(`${label}: 足された "${name}"`);
      continue;
    }
    const a = before.slots.get(name);
    const b = after.slots.get(name);
    /*
      ⚠ **`===` ではなく `Object.is`。** jsdom の `window.NaN` は `NaN !== NaN` なので、
        `===` で比べると**毎回「差し替えられた」**になり、この検査が常に赤くなる(2026-09-10 実測)。
    */
    const same = Array.isArray(a) && Array.isArray(b)
      ? Object.is(a[0], b[0]) && Object.is(a[1], b[1])
      : Object.is(a, b);
    if (!same) changes.push(`${label}: 差し替えられた "${name}"`);
  }
  for (const name of before.names) {
    if (!after.slots.has(name)) changes.push(`${label}: 消された "${name}"`);
  }
  return changes;
}

function prototypeChanges(before: Map<string, Fingerprint>): string[] {
  const changes: string[] = [];
  for (const [label, proto] of WATCHED_PROTOTYPES) {
    changes.push(...diffFingerprint(before.get(label)!, fingerprintOf(proto), `${label}.prototype`));
  }
  return changes;
}

function prototypeFingerprints(): Map<string, Fingerprint> {
  return new Map(WATCHED_PROTOTYPES.map(([label, proto]) => [label, fingerprintOf(proto)]));
}

let loaderCode = "";
let runtimeCode = "";

beforeAll(() => {
  /*
    🔴 **束ねるのを別プロセスでやる。** esbuild は jsdom の中では動かない
      (`new TextEncoder().encode("") instanceof Uint8Array` が別レルムのため false になり、
       esbuild 自身が「この環境は壊れている」と言って止まる。2026-09-09 実測)。
    🔴 **ここで毎回束ね直す。** 既にある `dist/` を読むだけにすると、
      **ソースを直して束ね忘れた人が、古い出力を測って緑になる**。
    ⚠ 読むのは「いま書き出されたもの」= 出荷する成果物そのもの。
  */
  const repoRoot = path.resolve(__dirname, "..");
  execFileSync("node", ["scripts/build-embed.mjs"], { cwd: repoRoot, stdio: "pipe" });
  loaderCode = readFileSync(path.join(repoRoot, BUNDLES[0].out), "utf8");
  runtimeCode = readFileSync(path.join(repoRoot, BUNDLES[1].out), "utf8");
  // 🔴 空を「違反なし」と読ませない
  expect(loaderCode.length, "ローダの出力が空 = 何も測っていない").toBeGreaterThan(500);
  expect(runtimeCode.length, "本体の出力が空 = 何も測っていない").toBeGreaterThan(500);
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  // 🔴 **前のテストが生やした鍵を全部消してから始める**(基準を毎回きれいにする)
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!PRISTINE_KEYS.has(key)) delete (window as unknown as Record<string, unknown>)[key];
  }
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 条件が満たされるまで待つ。**満たされないまま抜けない**(理由つきで落とす)。
 *
 * 🔴 **`flush()` を1回だけ挟むのは、こちらの環境でたまたま足りていただけだった**(2026-09-10・CI が捕まえた)。
 *   ここの `fetch` は**本物の `Response`** を返すので、`response.json()` は
 *   マイクロタスクだけでは終わらない(**本文の読み取りがマクロタスクをまたぐ**)。
 *   ローカルでは1回で間に合い、**CI では間に合わなかった** = 時間に依存した検査だった。
 * ⚠ 待ち切れなかったときに**黙って先へ進まない** —— 進むと
 *   「ポップが出ていないのに、汚していないと読む」= 検査が空回りする。
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  /*
    🔴🔴 **「何回待つか」ではなく「いつまで待つか」で書く**(2026-09-12 に踏んだ)。
      最初は `for (let i = 0; i < 50; i++) await flush()` と**回数**で書いていた。
      🔴 **回数は時間ではない** —— 束を全部並列で走らせると、50 回の `setTimeout(0)` が
        **数ミリ秒で終わってしまい**、まだ解決していない `Response.json()` を待ち切れない。
      実測: この束だけで走らせると6回とも緑、**全束を走らせると6回に1回赤**になった。
      ⚠ **落ちた原因を実装だと誤診しかけた**(実装は正しく、待ち方が足りていなかった)。
    ✅ **締め切り(既定5秒)まで、少しずつ間隔を空けて待つ。**
  */
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate(), `${label}(${timeoutMs}ms 待っても満たされなかった)`).toBe(true);
}

/** いま `window` に載っている bridge(**このテストが起動したローダのもの**)。 */
function currentBridge(): { request?: unknown; shown?: boolean } | undefined {
  return (window as unknown as Record<string, { request?: unknown; shown?: boolean } | undefined>)[
    NAMESPACE
  ];
}

/**
 * 離脱を検知させ、**本体が読み込まれる直前まで**進める。
 *
 * 🔴 **待つ条件を「script タグが増えたか」にしてはいけない**(2026-09-12 に踏んだ)。
 *   この束は **jsdom がファイルで1つ**なので、**前のテストが仕掛けた `mouseout` の listener が生きている**。
 *   そちらが先に反応して script を足すと、**こちらのローダがまだ設定を取り終えていないのに**
 *   待つのをやめてしまい、**描かれないまま「描画まで通した」と読む**ことになる。
 * ✅ **いまの bridge に注文が載ったか**で待つ。前のテストのローダは**古い bridge を掴んでいる**ので、
 *   こちらの条件は満たせない。
 */
async function driveToRuntime(): Promise<void> {
  await waitFor(() => {
    document.dispatchEvent(new MouseEvent("mouseout", { clientY: 0, relatedTarget: null }));
    return currentBridge()?.request !== undefined;
  }, "離脱を検知しても本体への注文が載らない");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("出荷する束ねた出力(t.js)", () => {
  it("① `document.write` / `document.writeln` を1度も呼ばない(描画を止めない)", () => {
    const trap: Trap = { calls: [] };
    vi.spyOn(document, "write").mockImplementation((...args: string[]) => {
      trap.calls.push(`write:${args.join("")}`);
    });
    vi.spyOn(document, "writeln").mockImplementation((...args: string[]) => {
      trap.calls.push(`writeln:${args.join("")}`);
    });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    installTag();

    evaluateBundle(loaderCode);

    expect(trap.calls).toEqual([]);
  });

  it("① 同期 XHR を1度も開かない", () => {
    const opens: Array<{ url: string; async: boolean }> = [];
    const original = XMLHttpRequest.prototype.open;
    vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      isAsync?: boolean,
    ) {
      opens.push({ url: String(url), async: isAsync !== false });
      return original.call(this, method, url as string, isAsync ?? true);
    } as typeof XMLHttpRequest.prototype.open);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    installTag();

    evaluateBundle(loaderCode);

    // ⚠ 「同期のものが無い」ではなく「**1本も開いていない**」を見る(XHR を使う理由が無い)
    expect(opens).toEqual([]);
  });

  it("🔴 ③ 発火して描画まで通しても、`window` に生やす鍵は1つだけ(非 enumerable と差し替えも見る)", async () => {
    /*
      🔴 **PR2 の最初の版は、ここで3つ取りこぼしていた**(Codex 1巡目・両モデル):
        ① `Object.keys` は**非 enumerable** な own property を見ない
        ② **既存メンバーの差し替え**(`window.fetch = …`)を見ない
        ③ **`arm` / `fire` / `draw` が一度も実行されていない**状態で測っていた
           = 汚しうるコードの大半を通していなかった
      ✅ 記述子の同一性で撮り、**離脱を検知させて本体を描くところまで通してから**測る。
    */
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(CONFIG_BODY, { status: 200 }))));
    installTag();
    // 🔴 前提の検算: この時点で既に汚れていたら、下の比較は何も測っていない
    const before = fingerprintOf(window);
    expect(
      before.names.filter((key) => !PRISTINE_KEYS.has(key)),
      "測り始める前から window が汚れている",
    ).toEqual([]);

    evaluateBundle(loaderCode);
    await driveToRuntime();
    evaluateBundle(runtimeCode);
    // 🔴 前提の検算②: **本当に描かれたか**(描かれていないなら draw を1行も通していない)
    await waitFor(
      () => document.querySelector("[data-adpop]") !== null,
      "ポップが出ていない = draw を測っていない",
    );

    expect(diffFingerprint(before, fingerprintOf(window), "window")).toEqual([
      'window: 足された "' + NAMESPACE + '"',
    ]);
  });

  it("🔴 ③ 発火して描画まで通しても、プロトタイプを1つも触らない(メソッドの差し替えも見る)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(CONFIG_BODY, { status: 200 }))));
    installTag();
    const before = prototypeFingerprints();

    evaluateBundle(loaderCode);
    await driveToRuntime();
    evaluateBundle(runtimeCode);
    await waitFor(
      () => document.querySelector("[data-adpop]") !== null,
      "ポップが出ていない = draw を測っていない",
    );

    expect(prototypeChanges(before)).toEqual([]);
  });

  it("🔴 この指紋は、実際に汚したら気づく(検査そのものの前提)", () => {
    /*
      🔴 **「差分が空だった」を「汚していない」と読む前に、汚したら赤くなることを見る。**
        3つの汚し方を1件ずつ撃つ —— どれか1つでも拾えないなら、上の2本は嘘をつく。
    */
    const beforeWindow = fingerprintOf(window);
    const beforeProtos = prototypeFingerprints();
    const originalPush = History.prototype.pushState;
    const originalFetch = Object.getOwnPropertyDescriptor(window, "fetch");
    try {
      // ① 非 enumerable な own property
      Object.defineProperty(window, "zzHidden", { value: 1, configurable: true, enumerable: false });
      expect(diffFingerprint(beforeWindow, fingerprintOf(window), "window")).toEqual([
        'window: 足された "zzHidden"',
      ]);
      delete (window as unknown as Record<string, unknown>).zzHidden;

      // ② 既存メンバーの差し替え
      Object.defineProperty(window, "fetch", { value: () => {}, configurable: true, writable: true });
      expect(diffFingerprint(beforeWindow, fingerprintOf(window), "window")).toEqual([
        'window: 差し替えられた "fetch"',
      ]);

      // ③ プロトタイプのメソッドの差し替え(名前の一覧は1文字も変わらない)
      History.prototype.pushState = function () {};
      expect(prototypeChanges(beforeProtos)).toEqual([
        'History.prototype: 差し替えられた "pushState"',
      ]);
    } finally {
      History.prototype.pushState = originalPush;
      if (originalFetch) Object.defineProperty(window, "fetch", originalFetch);
      delete (window as unknown as Record<string, unknown>).zzHidden;
    }
  });

  it("② タグが1つも無くても例外を投げない(貼り方を間違えた LP を壊さない)", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    expect(() => evaluateBundle(loaderCode)).not.toThrow();
  });

  it("② `localStorage` が例外を投げる環境でも壊れない(Safari のプライベート等)", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    installTag();

    expect(() => evaluateBundle(loaderCode)).not.toThrow();
  });

  it("② `fetch` そのものが例外を投げても壊れない", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("blocked by extension");
      }),
    );
    installTag();

    expect(() => evaluateBundle(loaderCode)).not.toThrow();
  });

  it("④ 配信が落ちても、DOM に1つも足さない(fail-closed)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))));
    installTag();
    const bodyChildren = document.body.childElementCount;

    evaluateBundle(loaderCode);
    // 拒否された Promise の処理が終わるまで待つ(未捕捉なら vitest が落とす)
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.body.childElementCount).toBe(bodyChildren);
    expect(document.querySelector("[data-adpop]")).toBeNull();
  });

  it("④ 設定が 500 でも、403 でも、壊れた JSON でも、何も出さない", async () => {
    for (const response of [
      new Response("", { status: 500 }),
      new Response(JSON.stringify({ ok: false }), { status: 403 }),
      new Response("これは JSON ではない", { status: 200 }),
    ]) {
      delete (window as unknown as Record<string, unknown>)[NAMESPACE];
      document.head.innerHTML = "";
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response)));
      installTag();

      evaluateBundle(loaderCode);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.querySelector("[data-adpop]")).toBeNull();
      expect(document.querySelector("script[src*='adpop.js']")).toBeNull();
    }
  });

  it("同じタグが2回貼られても1回しか動かない(多重読み込み耐性)", () => {
    const fetchSpy = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchSpy);
    installTag();
    installTag();

    evaluateBundle(loaderCode);
    evaluateBundle(loaderCode);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("🔴 `back` トリガが無効なら `history` に1ミリも触らない", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              v: 1,
              popup: {
                key: "p".repeat(32),
                minDisplayDelaySeconds: 0,
                frequency: { suppressDays: 0, sessionImpressions: 1, postConversionDays: 0 },
                // ⚠ back が入っていない
                triggers: [{ kind: "exit_intent", threshold: null }],
                variants: [
                  {
                    key: "v".repeat(32),
                    kind: "text",
                    weight: 100,
                    content: {},
                    destinationUrl: "https://offer.example.com/a",
                  },
                ],
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    installTag();

    evaluateBundle(loaderCode);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushState).not.toHaveBeenCalled();
  });
});

describe("🔴🔴 埋め込み先の履歴を1バイトも触らない(2026-09-12 本部裁定)", () => {
  /*
    🔴 **「戻る」トリガは PR2 から外した。** 4巡のうち3巡で、この1機能から Blocker が出続けたため
      (最短表示待ち中の吸収 → 出さないと決めた後の吸収 → 描画失敗・同期例外・SPA 遷移)。
      壊れ方が**この製品の唯一の約束**「配信が落ちてもポップが出ないだけ」を破る向きだった ——
      履歴を触る機能は、失敗すると**他人の LP の操作を奪う**。
    ✅ **PR4 で実ブラウザの検査(Playwright)を土台ごと用意してから戻す。**
    🔴 **それまでの守りがこの束。** ここを外さないと「戻る」は戻せない = **気づかずには戻せない。**
  */
  const HISTORY_METHODS = ["pushState", "replaceState", "back", "forward", "go"] as const;

  it("🔴 発火して描画まで通しても、`history` のメソッドを1度も呼ばない", async () => {
    const calls: string[] = [];
    for (const name of HISTORY_METHODS) {
      vi.spyOn(window.history, name).mockImplementation(((...args: unknown[]) => {
        calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
      }) as never);
    }
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(CONFIG_BODY, { status: 200 }))));
    installTag();

    evaluateBundle(loaderCode);
    await driveToRuntime();
    evaluateBundle(runtimeCode);
    await waitFor(
      () => document.querySelector("[data-adpop]") !== null,
      "ポップが出ていない = 描画まで通していない",
    );

    // 🔴 前提の検算: **`back` が有効な設定で**ここまで来ている(無視していることを測れている)
    expect(CONFIG_BODY).toContain('"back"');
    expect(calls, "埋め込み先の履歴を触った").toEqual([]);
  });

  it("🔴 `popstate` が飛んできても何もしない(listener を仕掛けていない)", async () => {
    const calls: string[] = [];
    for (const name of HISTORY_METHODS) {
      vi.spyOn(window.history, name).mockImplementation((() => calls.push(name)) as never);
    }
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(CONFIG_BODY, { status: 200 }))));
    installTag();
    evaluateBundle(loaderCode);
    await flush();

    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush();

    expect(calls).toEqual([]);
    expect(document.querySelector("script[src*='adpop.js']"), "戻るで発火した").toBeNull();
  });

  it("🔴 この検査は、実際に触ったら気づく(検査そのものの前提)", () => {
    /*
      🔴 **「呼ばれなかった」を「呼ばない実装だ」と読む前に、呼んだら赤くなることを見る。**
    */
    const calls: string[] = [];
    vi.spyOn(window.history, "pushState").mockImplementation((() => calls.push("pushState")) as never);
    window.history.pushState({}, "", location.href);
    expect(calls).toEqual(["pushState"]);
  });

  it("⚠ 束ねた出力に `history` という識別子が現れない(うっかり戻すのを止める)", () => {
    /*
      ⚠ **限界を正確に書く**: これは**出力の字面**を見ているだけなので、
        `win["hist" + "ory"]` のように書けば抜けられる。**意図的な迂回は止められない。**
      ✅ 止まるのは「**PR4 を待たずに、うっかり戻す**」ほう。上の2本(実際に呼ばれないこと)が本体で、
        こちらは**書きかけのコードが混ざったときに早く気づく**ための補助。
    */
    expect(loaderCode, "ローダに history が現れた").not.toContain("history");
    expect(runtimeCode, "本体に history が現れた").not.toContain("history");
  });
});

describe("写しの突き合わせ", () => {
  it("🔴 ローダが読みに行く本体の URL と、ビルドの出力先が一致している", () => {
    /*
      🔴 ここがずれると、**本体が 404 になって何も出ない**。しかも fail-closed なので
        エラーは1つも出ず、**静かに何も起きなくなる**(閉じすぎの故障は全部これになる)。
      ⚠ 「同じ文字列を2か所に書いている」ことを消せない(片方はビルドの設定、片方は配るコード)ので、
        **機械で突き合わせる**ほうを選んだ。
    */
    const runtime = BUNDLES.find((bundle) => bundle.id === "runtime");
    expect(runtime?.url).toBe(RUNTIME_PATH);
    expect(runtime?.publicOut).toBe(`public${RUNTIME_PATH}`);
  });

  it("ビルドの出力先が Next.js の配る場所(`public/`)の下にある", () => {
    for (const bundle of BUNDLES) {
      expect(bundle.publicOut.startsWith("public/")).toBe(true);
      expect(bundle.publicOut).toBe(`public${bundle.url}`);
    }
  });
});
