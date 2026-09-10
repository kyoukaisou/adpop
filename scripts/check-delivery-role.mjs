#!/usr/bin/env node
/*
  **配信専用ロール(`adpop_delivery`)で、起動中のローカル Supabase の DB へ直接つなぎ**、
  できること・できないことを両方撃つ。どちらかが外れたら非ゼロで終わる。

  前提: `npx supabase start` が済んでいること(CI では専用のジョブが起動する)。

  🔴 **このロールのパスワードはマイグレーションで設定しない**(リポジトリに秘密を入れない・
    本番へ同じ値を流さない)。ここでは **ローカルの使い捨て DB に対してだけ**、
    検査のためにその場で設定する。⚠ 下の値は**ローカル専用**で、秘密ではない。
*/
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import {
  ABSENT_ORIGIN,
  ABSENT_SITE_KEY,
  ALLOWED_PROBES,
  coverageProblems,
  DENIED_PROBES,
  evaluateAllowed,
  evaluateDenied,
} from "./delivery-role-expectations.mjs";

/** ⚠ **ローカルの使い捨てスタック専用**。本番のパスワードは運用側が別に設定する(README)。 */
const LOCAL_ONLY_PASSWORD = "adpop-local-delivery-not-a-secret";

function supabaseStatus() {
  const raw = execFileSync("npx", ["--no-install", "supabase", "status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

let status;
try {
  status = supabaseStatus();
} catch (error) {
  console.error(`NG  supabase status が取れません: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const adminUrl = status.DB_URL;
if (typeof adminUrl !== "string" || adminUrl.length === 0) {
  console.error("NG  DB_URL が supabase status から取れません");
  process.exit(1);
}

const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  await admin`select 1`;
} catch (error) {
  console.error(`NG  ローカルの DB に繋がりません: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

// 🔴 前提の検算: ロールが実在すること(無ければ 0005 が流れていない)
const roles = await admin`select rolname from pg_roles where rolname = 'adpop_delivery'`;
if (roles.length !== 1) {
  console.error("NG  adpop_delivery ロールがありません(0005 が適用されていない)");
  await admin.end();
  process.exit(1);
}
await admin.unsafe(`alter role adpop_delivery password '${LOCAL_ONLY_PASSWORD}'`);

const deliveryUrl = (() => {
  const u = new URL(adminUrl);
  u.username = "adpop_delivery";
  u.password = LOCAL_ONLY_PASSWORD;
  return u.toString();
})();
await admin.end();

const sql = postgres(deliveryUrl, { max: 1, prepare: false, onnotice: () => {} });

/*
  ══════════════════════════════════════════════════════════════════════
  ① できなければならないこと(**配り漏れ**の検出)
  ══════════════════════════════════════════════════════════════════════
*/
const allowed = [];
try {
  const r = await sql`select public.adpop_site_config(${ABSENT_SITE_KEY}, ${ABSENT_ORIGIN}) as out`;
  allowed.push({ id: "site_config", ok: true, value: r[0].out });
} catch (error) {
  allowed.push({ id: "site_config", ok: false, code: error?.code ?? "unknown" });
}
try {
  const r = await sql`
    select public.adpop_record_event(${ABSENT_SITE_KEY}, ${ABSENT_ORIGIN}, ${sql.json({ kind: "fire" })}) as out
  `;
  allowed.push({ id: "record_event", ok: true, value: r[0].out });
} catch (error) {
  allowed.push({ id: "record_event", ok: false, code: error?.code ?? "unknown" });
}

/*
  ══════════════════════════════════════════════════════════════════════
  ② できてはならないこと
  ══════════════════════════════════════════════════════════════════════
  ⚠ 1件ごとに接続を作り直す —— `set role` や失敗が**次の検査へ持ち越さない**ようにする。
*/
const denied = [];
for (const spec of DENIED_PROBES) {
  const one = postgres(deliveryUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await one.unsafe(spec.sql);
    denied.push({ id: spec.id, ok: true });
  } catch (error) {
    denied.push({ id: spec.id, ok: false, code: error?.code ?? "unknown" });
  } finally {
    await one.end();
  }
}
await sql.end();

let failed = false;
for (const problem of coverageProblems(allowed, denied)) {
  console.error(`NG  ${problem}`);
  failed = true;
}
for (const probe of allowed) {
  const result = evaluateAllowed(probe);
  console.log(`${result.ok ? "OK " : "NG "} ${result.reason}`);
  if (!result.ok) failed = true;
}
for (const probe of denied) {
  const result = evaluateDenied(probe);
  console.log(`${result.ok ? "OK " : "NG "} ${result.reason}`);
  if (!result.ok) failed = true;
}

if (failed) {
  console.error(
    "\n配信ロールの権限が期待どおりではありません。0005 の grant / revoke と関門(g1)〜(g6)を見てください。",
  );
  process.exit(1);
}
console.log(
  `\nOK  配信ロールは ${ALLOWED_PROBES.length} 件を呼べて、${DENIED_PROBES.length} 件は 42501 で断られました。`,
);
