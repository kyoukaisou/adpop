// @vitest-environment node
//
// `config.toml` の `[api] schemas` を読む判定を、両側で固定する。
// 🔴 この読み取りが黙って空配列を返すと、**関門との突き合わせが「差分なし」になって素通り**する。
import { describe, expect, it } from "vitest";
import { readApiSchemas } from "../scripts/supabase-config.mjs";

const withApi = (line: string) => `project_id = "adpop"\n\n[api]\nenabled = true\n${line}\n\n[db]\nport = 1\n`;

describe("読み取り(readApiSchemas)", () => {
  it("1行の配列を読む", () => {
    expect(readApiSchemas(withApi(`schemas = ["public", "graphql_public"]`))).toEqual({
      schemas: ["public", "graphql_public"],
    });
  });

  it("行末のコメントを落とす", () => {
    expect(readApiSchemas(withApi(`schemas = ["public"] # 絞ってある`))).toEqual({ schemas: ["public"] });
  });

  it("🔴 別のセクションの schemas を拾わない", () => {
    const toml = `[db]\nschemas = ["wrong"]\n\n[api]\nschemas = ["public"]\n`;
    expect(readApiSchemas(toml)).toEqual({ schemas: ["public"] });
  });

  it("🔴 行が無ければ error(空配列を返さない)", () => {
    expect(readApiSchemas(`[api]\nenabled = true\n`)).toHaveProperty("error");
  });

  it("🔴 読めない形は error(黙って空にしない)", () => {
    // 複数行の配列は扱わない
    expect(readApiSchemas(withApi(`schemas = [`))).toHaveProperty("error");
    expect(readApiSchemas(withApi(`schemas = [public]`))).toHaveProperty("error");
  });

  it("空の配列は空として読む", () => {
    expect(readApiSchemas(withApi(`schemas = []`))).toEqual({ schemas: [] });
  });
});
