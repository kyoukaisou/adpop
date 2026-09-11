/*
  **配信専用ロール(`adpop_delivery`)で DB へ直接つないだ結果**が期待どおりかを判定するモジュール。
  副作用なし。

  🔴 なぜ要るか(2026-09-11):
    0004 は `service_role` の鍵で PostgREST を呼び、「この鍵で届くのは関数2本だけ」と書いていた。
    **その主張は、測っていない範囲を含んでいた** —— 測っていたのは `/rest/v1` の `public` だけで、
    実際には **Auth Admin API(利用者の作成・削除)にも Storage API にも通っていた**。
  → 0005 で **PostgREST を経路から外し**、資格を **Postgres のロール1つ**にした。
    ここは **そのロールで実際につないで、できること・できないことを両方撃つ**。

  ⚠ **「できないこと」だけを並べない。** できることも同じ数だけ撃つ ——
    でないと「接続できていないから全部断られた」でも緑になる。
*/

/** ⚠ 形は通るが実在しないサイトキー。**関数まで届いたこと**の証明に使う。 */
export const ABSENT_SITE_KEY = "0".repeat(32);
export const ABSENT_ORIGIN = "https://not-registered.example.com";

/** 42501 = insufficient_privilege / 42501 以外は「別の理由で落ちた」= 不合格。 */
export const DENIED_SQLSTATE = "42501";

/**
 * **できなければならないこと**(逆向きの検査)。
 * 🔴 配り漏れると **配信だけが静かに止まる**(LP は fail-closed で無傷なので誰も気づかない)。
 */
export const ALLOWED_PROBES = [
  {
    id: "site_config",
    label: "配信の設定を引ける",
    /** 実在しないサイトなので `null`(fail-closed の応答)。**関数まで届いた証明**になる。 */
    expect: (value) => value === null,
    describe: () => "null(実在しないサイト)",
  },
  {
    id: "record_event",
    label: "イベント投入を呼べる",
    expect: (value) =>
      typeof value === "object" && value !== null && value.ok === false && value.reason === "not_allowed",
    describe: () => '{"ok":false,"reason":"not_allowed"}',
  },
];

/**
 * **できてはならないこと**。
 * ⚠ ここに並べるのは「**別の口から同じ場所へ届く**」経路 ——
 *   表・他のスキーマ・allow-list の外の関数・ロールの切り替え。
 */
export const DENIED_PROBES = [
  { id: "select_sites", label: "public.sites を読む", sql: "select * from public.sites limit 1" },
  { id: "select_events", label: "public.events を読む", sql: "select * from public.events limit 1" },
  {
    id: "insert_events",
    label: "public.events へ直接書く",
    sql: "insert into public.events (owner_id, site_id, kind, device) values (gen_random_uuid(), gen_random_uuid(), 'fire', 'mobile')",
  },
  { id: "select_auth_users", label: "auth.users を読む", sql: "select * from auth.users limit 1" },
  {
    id: "call_predicate",
    label: "allow-list の外の関数(adpop_is_https_url)を呼ぶ",
    sql: "select public.adpop_is_https_url('https://example.com')",
  },
  {
    id: "call_guard",
    label: "関門そのものを呼ぶ",
    sql: "select public.adpop_assert_privilege_rules()",
  },
  { id: "set_role_postgres", label: "postgres へ set role する", sql: "set role postgres" },
  { id: "create_table", label: "表を作る", sql: "create table public.zz_delivery_probe (id int)" },
  /*
    🔴 0006 で閉めた分。**閉めた結果を、実際のロールで叩いて確かめる。**
    ⚠ 一時表は「資源を食う」以外にも、**関数の探索パスに同名の表を割り込ませる**入口になりうる。
  */
  {
    id: "create_temp_table",
    label: "一時表を作る(database の TEMPORARY)",
    sql: "create temporary table zz_delivery_tmp (id int)",
  },
  { id: "create_schema", label: "スキーマを作る(database の CREATE)", sql: "create schema zz_delivery_ns" },
];

/**
 * **設定として載っていなければならないもの**。
 * 🔴 文の上限は**ロールの既定にしか無い**(2026-09-11 実測: 関数単位の SET は効かない /
 *   クライアントの起動時パラメータは pooler で残らない)。**実際に繋いで `show` で確かめる。**
 */
export const SETTING_PROBES = [
  { id: "statement_timeout", label: "文の上限", sql: "show statement_timeout", expect: "5s" },
  {
    id: "idle_in_transaction_session_timeout",
    label: "トランザクション放置の上限",
    sql: "show idle_in_transaction_session_timeout",
    expect: "10s",
  },
];

/**
 * @param {{ id: string, ok: boolean, value?: string, code?: string }} probe
 */
export function evaluateSetting(probe) {
  const spec = SETTING_PROBES.find((p) => p.id === probe.id);
  if (!spec) return { ok: false, reason: `${probe.id}: 期待値を決めていない検査` };
  if (!probe.ok) return { ok: false, reason: `${spec.label}: 読めなかった(${probe.code ?? "unknown"})` };
  if (probe.value !== spec.expect) {
    return { ok: false, reason: `${spec.label}: ${probe.value}(期待 ${spec.expect})` };
  }
  return { ok: true, reason: `${spec.label}: ${probe.value}` };
}

/**
 * @param {{ id: string, ok: boolean, value?: unknown, code?: string }} probe
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateAllowed(probe) {
  const spec = ALLOWED_PROBES.find((p) => p.id === probe.id);
  if (!spec) return { ok: false, reason: `${probe.id}: 期待値を決めていない検査` };
  if (!probe.ok) {
    return { ok: false, reason: `${spec.label}: 呼べなかった(${probe.code ?? "unknown"})= 配り漏れ` };
  }
  if (!spec.expect(probe.value)) {
    return {
      ok: false,
      reason: `${spec.label}: 応答が ${JSON.stringify(probe.value)}(期待 ${spec.describe()})`,
    };
  }
  return { ok: true, reason: `${spec.label}: ${spec.describe()}` };
}

/**
 * @param {{ id: string, ok: boolean, code?: string }} probe
 */
export function evaluateDenied(probe) {
  const spec = DENIED_PROBES.find((p) => p.id === probe.id);
  if (!spec) return { ok: false, reason: `${probe.id}: 期待値を決めていない検査` };
  if (probe.ok) return { ok: false, reason: `🔴 ${spec.label}: **できてしまった**` };
  if (probe.code !== DENIED_SQLSTATE) {
    /*
      🔴 **「落ちた」だけを合格にしない。** 接続が切れた・構文を間違えた、でも落ちる。
        **権限で断られた(42501)**ことまで突き合わせる。
    */
    return { ok: false, reason: `${spec.label}: SQLSTATE が ${probe.code}(期待 ${DENIED_SQLSTATE})` };
  }
  return { ok: true, reason: `${spec.label}: ${DENIED_SQLSTATE} で断られた` };
}

/** 🔴 「1件も測っていない」を合格にしない。 */
export function coverageProblems(allowed, denied, settings = []) {
  const problems = [];
  for (const spec of SETTING_PROBES) {
    if (!settings.some((p) => p.id === spec.id)) problems.push(`${spec.label} を1度も読んでいない`);
  }
  for (const spec of ALLOWED_PROBES) {
    if (!allowed.some((p) => p.id === spec.id)) problems.push(`${spec.label} を1度も試していない`);
  }
  for (const spec of DENIED_PROBES) {
    if (!denied.some((p) => p.id === spec.id)) problems.push(`${spec.label} を1度も試していない`);
  }
  return problems;
}
