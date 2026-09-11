// @vitest-environment node
//
// DB へつなぐ1枚(`src/lib/db/delivery.ts`)の**判定だけ**の検査。
// 🔴 ここが守るのは **TLS を降ろさないこと**(Codex 3巡目 Blocker)。
//   `postgres` の既定は `ssl: false` なので、書かないと**平文で流れうる**。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECT_TIMEOUT_SECONDS, sslModeFor } from "@/lib/db/delivery";

/** ⚠ ソースを直接読むのは、**「書いていないこと」を測る**ため(渡していない設定は実行時に観測できない)。 */
const SOURCE = readFileSync(path.resolve(__dirname, "../src/lib/db/delivery.ts"), "utf8");

const REMOTE = "postgresql://adpop_delivery:pw@db.example.supabase.co:6543/postgres";
const LOCAL = "postgresql://adpop_delivery:pw@127.0.0.1:54522/postgres";

describe("TLS の判定", () => {
  it("🔴 本番のホストは、既定で require", () => {
    expect(sslModeFor(REMOTE)).toBe("require");
  });

  it("🔴🔴 本番のホストは、`sslmode=disable` と書かれていても降ろさない", () => {
    /*
      🔴 **ここが要点。** 逃げ道はローカル専用で、**本番では絶対に降りない**。
        設定を1文字書き換えるだけで平文になる、を作らない。
    */
    expect(sslModeFor(`${REMOTE}?sslmode=disable`)).toBe("require");
  });

  it.each(["require", "prefer", "verify-full", "allow", "", "DISABLE"])(
    "⚠ `sslmode=%s` は降ろす合図にしない(fail-closed)",
    (mode) => {
      expect(sslModeFor(`${LOCAL}?sslmode=${mode}`)).toBe("require");
    },
  );

  it("⚠ ループバックでも、`sslmode=disable` と**書いたときだけ**降りる", () => {
    expect(sslModeFor(LOCAL), "黙って降りてはいけない").toBe("require");
    expect(sslModeFor(`${LOCAL}?sslmode=disable`)).toBe(false);
  });

  it.each([
    "postgresql://u:p@localhost:54322/postgres?sslmode=disable",
    "postgresql://u:p@127.0.0.1:54322/postgres?sslmode=disable",
    "postgresql://u:p@[::1]:54322/postgres?sslmode=disable",
  ])("ループバックの書き方3つとも降ろせる: %s", (url) => {
    expect(sslModeFor(url)).toBe(false);
  });

  it.each([
    "postgresql://u:p@127.0.0.1.evil.example.com:5432/postgres?sslmode=disable",
    "postgresql://u:p@localhost.evil.example.com:5432/postgres?sslmode=disable",
    "postgresql://u:p@0.0.0.0:5432/postgres?sslmode=disable",
    "postgresql://u:p@10.0.0.1:5432/postgres?sslmode=disable",
  ])("🔴 ループバックに**見せかけた**ホストでは降ろさない: %s", (url) => {
    expect(sslModeFor(url)).toBe("require");
  });

  it("🔴 URL として読めなければ require(読めないことを「降ろしてよい」と読まない)", () => {
    expect(sslModeFor("これは URL ではない")).toBe("require");
    expect(sslModeFor("")).toBe("require");
  });
});

describe("時間の上限として主張してよいもの", () => {
  it("⚠ クライアント側にあるのは接続の待ち時間だけ(文の上限はロールの既定に在る)", () => {
    /*
      🔴 **実測(2026-09-11)**:
        ・関数単位の `SET statement_timeout` は**効かない**(300ms の関数で 2秒の sleep が完走)
        ・ロールの既定は**効く**(同じ sleep が statement timeout で落ちた)
        ・クライアントの起動時パラメータは **pooler で残らない**
      → この束が固定するのは「**クライアントが持っているのは接続の待ち時間だけ**」という事実。
    */
    expect(CONNECT_TIMEOUT_SECONDS).toBe(5);
    expect(SOURCE, "クライアントで statement_timeout を渡している").not.toMatch(
      /connection:\s*\{[^}]*statement_timeout/,
    );
    expect(SOURCE, "ssl を明示していない").toMatch(/ssl:\s*sslModeFor\(url\)/);
  });
});
