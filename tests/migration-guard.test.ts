// @vitest-environment node
//
// 「すべてのマイグレーションは末尾で権限の関門を呼ぶ」判定を、**両側**で固定する。
// ⚠ 実物が守れていることは `supabase/tests/schema.test.ts` が見る。ここは判定そのもの。
import { describe, expect, it } from "vitest";
import { GUARD_CALL, endsWithGuardCall, meaningfulLines } from "../scripts/migration-guard.mjs";

describe("判定(endsWithGuardCall)", () => {
  it("末尾で呼んでいれば通る(後ろのコメントと空行は無視する)", () => {
    expect(endsWithGuardCall(`create table t (id int);\n${GUARD_CALL}\n\n-- おわり\n`)).toBe(true);
  });

  it("🔴 呼んでいなければ落ちる", () => {
    expect(endsWithGuardCall(`create table t (id int);\n`)).toBe(false);
  });

  it("🔴 途中で呼んで、その後に文を足していたら落ちる", () => {
    // 途中で呼んでも、その後に足した文は測られない
    expect(endsWithGuardCall(`${GUARD_CALL}\ngrant select on t to anon;\n`)).toBe(false);
  });

  it("🔴 コメントの中に書いてあるだけでは通らない", () => {
    expect(endsWithGuardCall(`create table t (id int);\n-- ${GUARD_CALL}\n`)).toBe(false);
  });

  it("空のファイルは通らない", () => {
    expect(endsWithGuardCall("")).toBe(false);
    expect(endsWithGuardCall("-- コメントだけ\n")).toBe(false);
  });
});

describe("行の拾い方", () => {
  it("行コメントと空行を落とす", () => {
    expect(meaningfulLines("-- a\n\n  select 1;\n-- b\n")).toEqual(["select 1;"]);
  });
});
