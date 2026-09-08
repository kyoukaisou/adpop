/*
  **実物の PostgREST を叩いた結果**が期待どおりかを判定するだけのモジュール(副作用なし)。

  🔴 なぜ実物を叩くのか(Codex 1巡目 High・両モデル):
    `supabase/tests/schema.test.ts` は PGlite に**手書きで再現した開始ACL**からマイグレーションを流す。
    **手書きの再現が Supabase の実物とずれたら、検査は「ずれた前提」を測り続ける**
    (= 測る対象の取り違え)。だから **CI で一度は実物を通す**。
  🔴 **fail-closed**: 接続できない・鍵が取れない・想定外のコードが返る、は**全部不合格**。
    「繋がらなかったので測れませんでした」を緑にしない。
*/

/** 業務テーブル。⚠ `supabase/tests/schema.test.ts` の TABLES と同じ並びにする。 */
export const TABLES = ["sites", "popups", "popup_triggers", "variants", "chatbot_nodes", "events"];

/**
 * 期待する形。
 * 🔴 **状態コードだけを見ない。** PostgREST は認証の失敗でも 401 を返すので、
 *   状態コードだけだと「鍵が壊れていて 401」を「権限で断られた」と読み違える。
 *   → **SQLSTATE(`code`)まで突き合わせる。**
 *
 * 🔴🔴 **ロールごとに状態コードを1つに固定する**(Codex 2巡目 Medium)。
 *   当初は「401 か 403 のどちらでも合格」にしていたので、
 *   **2つの鍵を取り違えても(極端には同じ鍵を2回使っても)12件とも合格**した。
 *   実測(ローカルの Supabase)= **anon は 401 / service_role は 403** で割れる。
 *   ⚠ したがってこの検査は「ロールごとに違う応答が返ること」も同時に測っている。
 */
export const EXPECTED_SQLSTATE = "42501";
export const EXPECTED_STATUS_BY_ROLE = { anon: 401, service_role: 403 };
export const ROLES = Object.keys(EXPECTED_STATUS_BY_ROLE);

/**
 * @param {{ role: string, table: string, status: number, body: unknown, error?: string }} probe
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateProbe(probe) {
  const where = `${probe.role} → ${probe.table}`;
  if (probe.error) return { ok: false, reason: `${where}: 要求そのものが失敗した(${probe.error})` };
  const expectedStatus = EXPECTED_STATUS_BY_ROLE[probe.role];
  if (expectedStatus === undefined) {
    return { ok: false, reason: `${where}: 期待値を決めていないロール` };
  }
  if (probe.status !== expectedStatus) {
    return { ok: false, reason: `${where}: HTTP ${probe.status}(期待 ${expectedStatus})` };
  }
  const body = probe.body;
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: `${where}: 本文が JSON のオブジェクトではない` };
  }
  const code = /** @type {{ code?: unknown }} */ (body).code;
  if (code !== EXPECTED_SQLSTATE) {
    return { ok: false, reason: `${where}: SQLSTATE が ${String(code)}(期待 ${EXPECTED_SQLSTATE})` };
  }
  return { ok: true, reason: `${where}: HTTP ${probe.status} / ${EXPECTED_SQLSTATE}` };
}

/*
  ══════════════════════════════════════════════════════════════════════
  鍵そのものの検査(**12件を走らせる前に**)
  ══════════════════════════════════════════════════════════════════════
  🔴 **「全部断られた」は、正しい鍵で叩いたときにしか意味がない。**
    鍵を取り違えていると、**anon の口を1度も叩かないまま12件緑**になる。
  ⚠ ローカルの Supabase の `ANON_KEY` / `SERVICE_ROLE_KEY` は JWT で、
    payload に `role` claim が入っている。**復号して期待ロールと突き合わせる。**
  ⚠ **署名は検証しない**(こちらは鍵の中身を知らない)。見ているのは
    「**どのロールを名乗る鍵か**」と「**2つが別物か**」の2つだけ。
*/

/** @returns {{ role: string } | { error: string }} */
export function decodeJwtRole(key) {
  if (typeof key !== "string" || key.length === 0) return { error: "鍵が空" };
  const parts = key.split(".");
  if (parts.length !== 3) return { error: "JWT の形(3つの部分)ではない" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { error: "payload を復号できない" };
  }
  if (typeof payload !== "object" || payload === null) return { error: "payload がオブジェクトではない" };
  const role = /** @type {{ role?: unknown }} */ (payload).role;
  if (typeof role !== "string" || role.length === 0) return { error: "payload に role claim が無い" };
  return { role };
}

/**
 * @param {Record<string, string>} keys ロール名 → 鍵
 * @returns {string[]} 空配列 = 鍵は期待どおり
 */
export function keyProblems(keys) {
  const problems = [];
  for (const role of ROLES) {
    const key = keys[role];
    const decoded = decodeJwtRole(key);
    if ("error" in decoded) {
      problems.push(`${role} の鍵を読めません(${decoded.error})`);
      continue;
    }
    if (decoded.role !== role) {
      problems.push(`${role} の鍵が名乗っているロールは "${decoded.role}"(取り違え)`);
    }
  }
  const values = ROLES.map((role) => keys[role]);
  if (new Set(values).size !== values.length) {
    problems.push("2つの鍵が同じです(同じ口を2回叩くことになる)");
  }
  return problems;
}

/**
 * 🔴 **「1件も測っていない」を合格にしない。**
 * @param {Array<{ role: string, table: string }>} probes
 * @param {string[]} roles
 */
export function coverageProblems(probes, roles) {
  const problems = [];
  for (const role of roles) {
    for (const table of TABLES) {
      if (!probes.some((p) => p.role === role && p.table === table)) {
        problems.push(`${role} → ${table} を1度も叩いていない`);
      }
    }
  }
  return problems;
}
