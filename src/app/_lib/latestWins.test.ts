import { describe, expect, it } from "vitest";
import { createLatestWinsGuard, fetchLatestWins } from "./latestWins";

describe("createLatestWinsGuard", () => {
  it("next() のたびに違う印を返す。isLatest は最後に発行した印にだけ true", () => {
    const guard = createLatestWinsGuard();
    const a = guard.next();
    const b = guard.next();
    expect(a).not.toBe(b);
    expect(guard.isLatest(a)).toBe(false); // bの後ではaは最新ではない
    expect(guard.isLatest(b)).toBe(true);
  });
});

/** テスト内で解決タイミングを手で制御するための、解決関数つきPromise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("fetchLatestWins(D-384 Codexレビュー指摘1: 期間の応答が逆転したとき)", () => {
  it("🔴 先に出したリクエストの応答が、後から出したリクエストの応答より遅れて届いても、最後に出した方だけが反映される", async () => {
    const guard = createLatestWinsGuard();
    const results: string[] = [];
    const starts: number[] = [];

    const first = deferred<string>(); // 先に出す(90日相当)。遅れて解決する
    const second = deferred<string>(); // 後に出す(7日相当)。先に解決する

    const p1 = fetchLatestWins(
      guard,
      () => first.promise,
      () => starts.push(1),
      (r) => results.push(`first:${r}`),
    );
    const p2 = fetchLatestWins(
      guard,
      () => second.promise,
      () => starts.push(2),
      (r) => results.push(`second:${r}`),
    );

    // 🔴 後に出した方(second)を先に解決する(応答の逆転そのもの)
    second.resolve("90→7の7日分");
    await p2;
    expect(results).toEqual(["second:90→7の7日分"]);

    // 遅れて first が解決しても、もう無視される(古い応答で上書きしない)
    first.resolve("先に出した90日分(遅れて到着)");
    await p1;
    expect(results).toEqual(["second:90→7の7日分"]); // 増えない

    expect(starts).toEqual([1, 2]); // onStartは発行順どおりに呼ばれる(読み込み中への切り替えは即座)
  });

  it("✅ 順番どおりに返ってくる通常のケースでは、両方とも反映される(最後に発行したものが最後の値のまま残る)", async () => {
    const guard = createLatestWinsGuard();
    const results: string[] = [];
    await fetchLatestWins(guard, () => Promise.resolve("1回目"), () => {}, (r) => results.push(r));
    await fetchLatestWins(guard, () => Promise.resolve("2回目"), () => {}, (r) => results.push(r));
    expect(results).toEqual(["1回目", "2回目"]);
  });

  it("onStart は fetcher を呼ぶ前(応答を待たずに)同期的に呼ばれる", async () => {
    const guard = createLatestWinsGuard();
    const order: string[] = [];
    await fetchLatestWins(
      guard,
      async () => {
        order.push("fetch");
        return "x";
      },
      () => order.push("start"),
      () => order.push("result"),
    );
    expect(order).toEqual(["start", "fetch", "result"]);
  });
});
