// @vitest-environment node
//
// `scripts/delivery-origin-guard.mjs`(deploy 前に、配信元が `deploy/delivery-origin.txt` の
// 確定値と完全一致しているかを見る検査)の判定そのものを固定する。
// Codex r2 Blocker 2: 前巡の検査は「決定済みの形」(`adpop-delivery.<任意の文字列>.workers.dev`)
// であれば通していたため、別アカウント名やタイプミスでも通った。この検査は**完全一致**だけを見る。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_ORIGIN_FILE,
  deliveryOriginGuardProblems,
  readExpectedDeliveryOrigin,
  UNSET_DELIVERY_ORIGIN,
} from "../scripts/delivery-origin-guard.mjs";

const CONFIRMED = "https://adpop-delivery.myaccount.workers.dev";

describe("deliveryOriginGuardProblems(4つの場合)", () => {
  it("🔴 ①仮の値(UNSET)のときは止まる", () => {
    const problems = deliveryOriginGuardProblems({ actualOrigin: CONFIRMED, expectedOrigin: UNSET_DELIVERY_ORIGIN });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("まだ確定していない");
  });

  it("🔴 ②1文字違いのときは止まる", () => {
    const oneCharOff = "https://adpop-delivery.myaccountt.workers.dev";
    const problems = deliveryOriginGuardProblems({ actualOrigin: oneCharOff, expectedOrigin: CONFIRMED });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("一致");
  });

  it("🔴 ③アカウント名が違うときは止まる", () => {
    const otherAccount = "https://adpop-delivery.otheraccount.workers.dev";
    const problems = deliveryOriginGuardProblems({ actualOrigin: otherAccount, expectedOrigin: CONFIRMED });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("✅ ④完全一致のときは通る", () => {
    expect(deliveryOriginGuardProblems({ actualOrigin: CONFIRMED, expectedOrigin: CONFIRMED })).toEqual([]);
  });
});

describe("deliveryOriginGuardProblems(追加の境界)", () => {
  it("expectedOrigin が空文字のときも「未確定」と同じに扱う", () => {
    const problems = deliveryOriginGuardProblems({ actualOrigin: CONFIRMED, expectedOrigin: "" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("まだ確定していない");
  });

  it("actualOrigin が未指定(undefined)で expectedOrigin が確定値のときは一致しないとして止まる", () => {
    const problems = deliveryOriginGuardProblems({ actualOrigin: undefined, expectedOrigin: CONFIRMED });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("前後の空白だけが違う場合も、trim 後の値で一致していれば通る(ファイルの末尾改行を想定)", () => {
    expect(deliveryOriginGuardProblems({ actualOrigin: CONFIRMED, expectedOrigin: `${CONFIRMED}\n` })).toEqual([]);
  });
});

describe("readExpectedDeliveryOrigin / deploy/delivery-origin.txt", () => {
  it("リポジトリの現在の状態は UNSET(まだ確定していない)", () => {
    expect(readExpectedDeliveryOrigin()).toBe(UNSET_DELIVERY_ORIGIN);
  });

  it("DELIVERY_ORIGIN_FILE が実際にそのファイルを指している", () => {
    expect(readFileSync(DELIVERY_ORIGIN_FILE, "utf8").trim()).toBe(UNSET_DELIVERY_ORIGIN);
  });
});
