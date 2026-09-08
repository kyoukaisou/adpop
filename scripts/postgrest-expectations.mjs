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
 */
export const EXPECTED_SQLSTATE = "42501";
export const EXPECTED_STATUSES = [401, 403];

/**
 * @param {{ role: string, table: string, status: number, body: unknown, error?: string }} probe
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateProbe(probe) {
  const where = `${probe.role} → ${probe.table}`;
  if (probe.error) return { ok: false, reason: `${where}: 要求そのものが失敗した(${probe.error})` };
  if (!EXPECTED_STATUSES.includes(probe.status)) {
    return { ok: false, reason: `${where}: HTTP ${probe.status}(期待 ${EXPECTED_STATUSES.join(" か ")})` };
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
