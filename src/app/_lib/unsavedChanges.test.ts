// 🔴 vitest の jsdom 環境はファイルで1つしか持てないので(tests/embed-flow.test.ts と同じ理由)、
//   JSDOM を直接使ってテストごとに新しい window を作る。
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { attachBeforeUnloadGuard } from "./unsavedChanges";

function fireBeforeUnload(dom: JSDOM): Event {
  const event = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(event);
  return event;
}

describe("attachBeforeUnloadGuard", () => {
  it("🔴 bypass されていなければ beforeunload を preventDefault する(確認が出る)", () => {
    const dom = new JSDOM("<!doctype html>");
    const detach = attachBeforeUnloadGuard(
      dom.window as unknown as Window,
      () => false,
      () => {},
    );
    const event = fireBeforeUnload(dom);
    expect(event.defaultPrevented).toBe(true);
    detach();
  });

  it("🔴 bypass されていれば preventDefault しない(確認モーダルで確定した直後の1回分の遷移)", () => {
    const dom = new JSDOM("<!doctype html>");
    let bypassed = true;
    const detach = attachBeforeUnloadGuard(
      dom.window as unknown as Window,
      () => bypassed,
      () => {
        bypassed = false;
      },
    );
    const event = fireBeforeUnload(dom);
    expect(event.defaultPrevented).toBe(false);
    detach();
  });

  it("🔴 Codex r1 Blocker: bypass は1回使ったら消費され、2回目の beforeunload は通常どおり止める(以前は一度 true にすると永久に抑止され続けていた)", () => {
    const dom = new JSDOM("<!doctype html>");
    let bypassed = true;
    const detach = attachBeforeUnloadGuard(
      dom.window as unknown as Window,
      () => bypassed,
      () => {
        bypassed = false;
      },
    );
    const first = fireBeforeUnload(dom);
    expect(first.defaultPrevented).toBe(false);
    const second = fireBeforeUnload(dom);
    expect(second.defaultPrevented).toBe(true);
    detach();
  });

  it("🔴 cancelBypass 相当(consumeBypassを呼んで武装解除): 未消費のbypassを取り消した後は、次のbeforeunloadを通常どおり止める(ログアウト失敗など、実際には離脱しなかったときの経路)", () => {
    const dom = new JSDOM("<!doctype html>");
    let bypassed = true;
    const cancel = () => {
      bypassed = false;
    };
    const detach = attachBeforeUnloadGuard(dom.window as unknown as Window, () => bypassed, cancel);
    cancel(); // 離脱に失敗したので、武装したbypassを使う前に取り消す
    const event = fireBeforeUnload(dom);
    expect(event.defaultPrevented).toBe(true);
    detach();
  });

  it("detach 後は何も起きない(リスナーが外れている)", () => {
    const dom = new JSDOM("<!doctype html>");
    const detach = attachBeforeUnloadGuard(
      dom.window as unknown as Window,
      () => false,
      () => {},
    );
    detach();
    const event = fireBeforeUnload(dom);
    expect(event.defaultPrevented).toBe(false);
  });
});
