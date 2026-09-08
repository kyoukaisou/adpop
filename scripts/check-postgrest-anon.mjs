#!/usr/bin/env node
/*
  **起動中のローカル Supabase(実物の PostgREST)**に anon キーと service_role キーで当たり、
  業務テーブルへ1つも届かないことを確かめる。届いてしまったら非ゼロで終わる。

  前提: `npx supabase start` が済んでいること(CI では専用のジョブが起動する)。
  判定は `scripts/postgrest-expectations.mjs` の1本だけが持つ(テストで両側を固定してある)。

  ⚠ **この検査が守るもの**: PGlite 側の「開始ACLの再現」が実物とずれていないこと。
  ⚠ **守らないもの**: 認証済み(authenticated)の経路。**まだログインする画面が無い**(PR3)。
*/
import { execFileSync } from "node:child_process";
import { coverageProblems, evaluateProbe, TABLES } from "./postgrest-expectations.mjs";

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
  console.error("    (`npx supabase start` が済んでいるか確認してください)");
  process.exit(1);
}

const apiUrl = status.API_URL;
const keys = { anon: status.ANON_KEY, service_role: status.SERVICE_ROLE_KEY };
// 🔴 鍵が取れないまま「全部 401 だった」と報告しない(fail-closed)
for (const [role, key] of Object.entries(keys)) {
  if (typeof key !== "string" || key.length === 0) {
    console.error(`NG  ${role} の鍵が supabase status から取れません`);
    process.exit(1);
  }
}
if (typeof apiUrl !== "string" || apiUrl.length === 0) {
  console.error("NG  API_URL が supabase status から取れません");
  process.exit(1);
}

const probes = [];
for (const [role, key] of Object.entries(keys)) {
  for (const table of TABLES) {
    const probe = { role, table, status: 0, body: null, error: undefined };
    try {
      const response = await fetch(`${apiUrl}/rest/v1/${table}?select=*`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      probe.status = response.status;
      probe.body = await response.json().catch(() => null);
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }
    probes.push(probe);
  }
}

let failed = false;
for (const problem of coverageProblems(probes, Object.keys(keys))) {
  console.error(`NG  ${problem}`);
  failed = true;
}
for (const probe of probes) {
  const result = evaluateProbe(probe);
  console.log(`${result.ok ? "OK " : "NG "} ${result.reason}`);
  if (!result.ok) failed = true;
}

if (failed) {
  console.error("\n実物の PostgREST から業務テーブルに届いています。0001 / 0002 の権限を見てください。");
  process.exit(1);
}
console.log(`\nOK  ${probes.length} 件すべてが権限で断られました(anon / service_role × ${TABLES.length}表)。`);
