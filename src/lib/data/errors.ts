/*
  D1 の失敗を**分類する**(画面の文言にするのは管理画面の側)。
  ⚠ D1 はエラーを **SQLSTATE ではなく文言**で返す(例: `D1_ERROR: adpop:limit:sites: SQLITE_CONSTRAINT ...`)。
    分類は**こちらが RAISE で付けた接頭辞**と、SQLite の拡張エラーコードの名前で行う。
    ⚠ 文言の形は D1 の実装に依存する(契約ではない)。`tests/d1-semantics.test.ts` が実物の形を固定している。
*/
import type { LimitTarget } from "./limits";

export type DataFailure =
  | { kind: "limit"; target: LimitTarget }
  | { kind: "immutable" }
  | { kind: "unique" }
  | { kind: "check" }
  | { kind: "foreign_key" }
  | { kind: "unknown"; detail: string };

const LIMIT_TARGETS: readonly LimitTarget[] = ["sites", "popupsPerSite", "variantsPerPopup"];

export function classifyD1Error(error: unknown): DataFailure {
  const message = error instanceof Error ? error.message : String(error);
  const limit = /adpop:limit:([A-Za-z]+)/.exec(message);
  if (limit && (LIMIT_TARGETS as readonly string[]).includes(limit[1])) {
    return { kind: "limit", target: limit[1] as LimitTarget };
  }
  if (message.includes("adpop:immutable:")) return { kind: "immutable" };
  if (
    message.includes("adpop:conflict:") ||
    message.includes("SQLITE_CONSTRAINT_UNIQUE") ||
    message.includes("SQLITE_CONSTRAINT_PRIMARYKEY")
  ) {
    return { kind: "unique" };
  }
  if (message.includes("SQLITE_CONSTRAINT_FOREIGNKEY")) return { kind: "foreign_key" };
  if (message.includes("SQLITE_CONSTRAINT_CHECK") || message.includes("SQLITE_CONSTRAINT_NOTNULL")) {
    return { kind: "check" };
  }
  return { kind: "unknown", detail: message };
}
