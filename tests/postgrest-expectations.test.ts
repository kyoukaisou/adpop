// @vitest-environment node
//
// 実物の PostgREST を叩く検査の**判定そのもの**を、両側で固定する。
// 🔴 実物を叩くジョブは CI にしか無いので、判定が甘いと**誰も気づかないまま緑**になる。
import { describe, expect, it } from "vitest";
import {
  coverageProblems,
  evaluateProbe,
  EXPECTED_SQLSTATE,
  EXPECTED_STATUSES,
  TABLES,
} from "../scripts/postgrest-expectations.mjs";

const base = { role: "anon", table: "sites" };

describe("判定(evaluateProbe)", () => {
  it("✅ 401 + 42501 は合格(実測で撮った形)", () => {
    expect(evaluateProbe({ ...base, status: 401, body: { code: "42501" } }).ok).toBe(true);
  });

  it("✅ 403 + 42501 も合格(service_role で実測した形)", () => {
    expect(evaluateProbe({ ...base, role: "service_role", status: 403, body: { code: "42501" } }).ok).toBe(true);
  });

  it("🔴 200 は不合格(届いてしまっている)", () => {
    const result = evaluateProbe({ ...base, status: 200, body: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("HTTP 200");
  });

  it("🔴 状態コードが合っていても SQLSTATE が違えば不合格", () => {
    /*
      🔴 ここが要点 —— PostgREST は**鍵が壊れているときも 401** を返す。
        状態コードだけを見ると「鍵が壊れて 401」を「権限で断られた」と読み違える。
    */
    const result = evaluateProbe({ ...base, status: 401, body: { code: "PGRST301" } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("PGRST301");
  });

  it("🔴 本文が JSON のオブジェクトでなければ不合格", () => {
    expect(evaluateProbe({ ...base, status: 401, body: null }).ok).toBe(false);
    expect(evaluateProbe({ ...base, status: 401, body: "denied" }).ok).toBe(false);
  });

  it("🔴 要求そのものが失敗したら不合格(繋がらないを緑にしない)", () => {
    const result = evaluateProbe({ ...base, status: 0, body: null, error: "ECONNREFUSED" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
  });
});

describe("測った範囲(coverageProblems)", () => {
  it("🔴 1件も叩いていなければ、その分だけ問題として挙がる", () => {
    expect(coverageProblems([], ["anon", "service_role"])).toHaveLength(TABLES.length * 2);
  });

  it("✅ 全部叩いていれば問題なし", () => {
    const probes = ["anon", "service_role"].flatMap((role) => TABLES.map((table) => ({ role, table })));
    expect(coverageProblems(probes, ["anon", "service_role"])).toEqual([]);
  });

  it("🔴 1表でも抜けたら気づく", () => {
    const probes = ["anon", "service_role"].flatMap((role) =>
      TABLES.filter((t) => t !== "events").map((table) => ({ role, table })),
    );
    expect(coverageProblems(probes, ["anon", "service_role"])).toEqual([
      "anon → events を1度も叩いていない",
      "service_role → events を1度も叩いていない",
    ]);
  });
});

describe("期待値の宣言", () => {
  it("6表・42501・401/403", () => {
    expect(TABLES).toEqual(["sites", "popups", "popup_triggers", "variants", "chatbot_nodes", "events"]);
    expect(EXPECTED_SQLSTATE).toBe("42501");
    expect(EXPECTED_STATUSES).toEqual([401, 403]);
  });
});
