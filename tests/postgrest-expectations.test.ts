// @vitest-environment node
//
// 実物の PostgREST を叩く検査の**判定そのもの**を、両側で固定する。
// 🔴 実物を叩くジョブは CI にしか無いので、判定が甘いと**誰も気づかないまま緑**になる。
import { describe, expect, it } from "vitest";
import {
  coverageProblems,
  decodeJwtRole,
  evaluateProbe,
  EXPECTED_SQLSTATE,
  EXPECTED_STATUS_BY_ROLE,
  keyProblems,
  ROLES,
  TABLES,
  ABSENT_SITE_KEY,
  evaluateRpcProbe,
  RPC_PROBES,
  rpcCoverageProblems,
} from "../scripts/postgrest-expectations.mjs";

/** テスト用の JWT(署名は見ないので payload だけが意味を持つ)。 */
function fakeJwt(payload: Record<string, unknown>, salt = ""): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig${salt}`;
}

const base = { role: "anon", table: "sites" };

describe("判定(evaluateProbe)", () => {
  it("✅ 401 + 42501 は合格(実測で撮った形)", () => {
    expect(evaluateProbe({ ...base, status: 401, body: { code: "42501" } }).ok).toBe(true);
  });

  it("✅ 403 + 42501 も合格(service_role で実測した形)", () => {
    expect(evaluateProbe({ ...base, role: "service_role", status: 403, body: { code: "42501" } }).ok).toBe(true);
  });

  it("🔴 ロールごとに状態コードを1つに固定している(取り違えに気づくため)", () => {
    /*
      🔴 Codex 2巡目 Medium —— 「401 か 403 のどちらでも合格」だと、
        **2つの鍵を取り違えても・同じ鍵を2回使っても12件緑**になる。
    */
    expect(evaluateProbe({ ...base, role: "anon", status: 403, body: { code: "42501" } }).ok).toBe(false);
    expect(
      evaluateProbe({ ...base, role: "service_role", status: 401, body: { code: "42501" } }).ok,
    ).toBe(false);
  });

  it("🔴 期待値を決めていないロールは不合格", () => {
    expect(evaluateProbe({ ...base, role: "postgres", status: 401, body: { code: "42501" } }).ok).toBe(false);
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

describe("鍵の検査(12件を叩く前)", () => {
  const anon = fakeJwt({ role: "anon", iss: "supabase-demo" });
  const service = fakeJwt({ role: "service_role", iss: "supabase-demo" });

  it("✅ 期待どおりの2本なら問題なし", () => {
    expect(keyProblems({ anon, service_role: service })).toEqual([]);
  });

  it("🔴 2本が同じ鍵なら不合格(同じ口を2回叩くことになる)", () => {
    const problems = keyProblems({ anon, service_role: anon });
    // 「service_role の鍵が anon を名乗る」と「2本が同じ」の両方が出る
    expect(problems.length).toBeGreaterThanOrEqual(1);
    expect(problems.join("\n")).toContain("同じ");
  });

  it("🔴 取り違え(anon の欄に service_role の鍵)を捕まえる", () => {
    const problems = keyProblems({ anon: service, service_role: anon });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("service_role");
  });

  it("🔴 JWT でない鍵(新形式の sb_publishable_… 等)は不合格", () => {
    const problems = keyProblems({ anon: "sb_publishable_abc", service_role: service });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("JWT の形");
  });

  it("🔴 role claim が無ければ不合格", () => {
    expect(decodeJwtRole(fakeJwt({ iss: "x" }))).toHaveProperty("error");
    expect(decodeJwtRole("")).toHaveProperty("error");
    expect(decodeJwtRole("a.b.c")).toHaveProperty("error");
  });

  it("✅ 読める鍵からはロールを取り出せる", () => {
    expect(decodeJwtRole(anon)).toEqual({ role: "anon" });
  });
});

describe("期待値の宣言", () => {
  it("6表・42501・anon=401 / service_role=403", () => {
    expect(TABLES).toEqual(["sites", "popups", "popup_triggers", "variants", "chatbot_nodes", "events"]);
    expect(EXPECTED_SQLSTATE).toBe("42501");
    expect(EXPECTED_STATUS_BY_ROLE).toEqual({ anon: 401, service_role: 403 });
    expect(ROLES).toEqual(["anon", "service_role"]);
  });
});

/*
  ══════════════════════════════════════════════════════════════════════════
  配信の口(0003 の RPC 2本)の判定 —— **逆向き**
  ══════════════════════════════════════════════════════════════════════════
  🔴 上の12件は全部「**届いていないこと**」を測っている。
    0003 で anon から呼べる関数を2本開けたので、「**届くこと**」も測らないと、
    配り漏れ(= 配信が静かに止まる)を1つも検出できない。
*/
describe("配信の口の判定(evaluateRpcProbe)", () => {
  const siteConfig = RPC_PROBES.find((rpc) => rpc.name === "adpop_site_config")!;
  const recordEvent = RPC_PROBES.find((rpc) => rpc.name === "adpop_record_event")!;

  it("✅ anon が 200 + fail-closed の応答なら合格", () => {
    expect(
      evaluateRpcProbe({ role: "anon", name: "adpop_site_config", status: 200, body: null }, siteConfig).ok,
    ).toBe(true);
    expect(
      evaluateRpcProbe(
        { role: "anon", name: "adpop_record_event", status: 200, body: { ok: false, reason: "site" } },
        recordEvent,
      ).ok,
    ).toBe(true);
  });

  it("🔴 anon が 401 / 403 なら不合格(**配り漏れ** = 配信が静かに止まる)", () => {
    for (const status of [401, 403]) {
      expect(
        evaluateRpcProbe({ role: "anon", name: "adpop_site_config", status, body: { code: "42501" } }, siteConfig)
          .ok,
        `HTTP ${status}`,
      ).toBe(false);
    }
  });

  it("🔴 anon が 200 でも本文が違えば不合格(実在しないサイトに設定を返してはいけない)", () => {
    expect(
      evaluateRpcProbe(
        { role: "anon", name: "adpop_site_config", status: 200, body: { v: 1, popup: {} } },
        siteConfig,
      ).ok,
    ).toBe(false);
    expect(
      evaluateRpcProbe(
        { role: "anon", name: "adpop_record_event", status: 200, body: { ok: true, stored: true } },
        recordEvent,
      ).ok,
      "実在しないサイトのイベントが入った",
    ).toBe(false);
  });

  it("🔴 service_role は呼べてはいけない(開けたのは anon の1本道だけ)", () => {
    expect(
      evaluateRpcProbe(
        { role: "service_role", name: "adpop_site_config", status: 403, body: { code: "42501" } },
        siteConfig,
      ).ok,
    ).toBe(true);
    expect(
      evaluateRpcProbe({ role: "service_role", name: "adpop_site_config", status: 200, body: null }, siteConfig)
        .ok,
      "service_role から呼べてしまった",
    ).toBe(false);
  });

  it("要求そのものが失敗したら不合格(繋がらないことを緑にしない)", () => {
    expect(
      evaluateRpcProbe(
        { role: "anon", name: "adpop_site_config", status: 0, body: null, error: "ECONNREFUSED" },
        siteConfig,
      ).ok,
    ).toBe(false);
  });

  it("🔴 1本でも叩いていなければ不合格", () => {
    expect(rpcCoverageProblems([], ROLES)).toHaveLength(ROLES.length * RPC_PROBES.length);
    expect(
      rpcCoverageProblems(
        ROLES.flatMap((role) => RPC_PROBES.map((rpc) => ({ role, name: rpc.name }))),
        ROLES,
      ),
    ).toEqual([]);
  });

  it("⚠ 使うサイトキーは「形は通るが実在しない」ものである(関数まで届くことの証明になる)", () => {
    expect(ABSENT_SITE_KEY).toMatch(/^[0-9a-f]{32}$/);
  });
});
