// @vitest-environment node
//
// 管理画面の認証の部品(src/admin/crypto.ts)と、パスワードを作るスクリプト(scripts/admin-hash.mjs)。
import { describe, expect, it } from "vitest";
import {
  connectingAddress,
  constantTimeEqual,
  formatPasswordHash,
  parsePasswordHash,
  pbkdf2,
  PBKDF2_ITERATIONS,
} from "../src/admin/crypto";
import { base32, generateSecrets } from "../scripts/admin-hash.mjs";

describe("パスワードの生成(監査 H1)", () => {
  it("🔴 パスワードは 128 ビットの乱数(base32 で 26 文字)。毎回違う", async () => {
    const a = await generateSecrets();
    const b = await generateSecrets();
    expect(a.password).toMatch(/^[A-Z2-7]{26}$/);
    expect(a.password).not.toBe(b.password);
    expect(base32(new Uint8Array(16)).length).toBe(26);
  });

  it("🔴 スクリプトのハッシュは、API の照合(crypto.ts)でそのまま検証できる", async () => {
    const s = await generateSecrets();
    const parsed = parsePasswordHash(s.passwordHash)!;
    expect(parsed).not.toBeNull();
    expect(constantTimeEqual(await pbkdf2(s.password, parsed.salt), parsed.hash)).toBe(true);
    expect(constantTimeEqual(await pbkdf2(`${s.password}x`, parsed.salt), parsed.hash)).toBe(false);
    expect(formatPasswordHash(parsed.salt, parsed.hash)).toBe(s.passwordHash);
    expect(s.rateLimitKey.length).toBeGreaterThanOrEqual(43);
  });
});

describe("保存の形は完全一致で読む(監査 L7)", () => {
  const good = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  it("✅ 反復 100000 の正しい形は読める", () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(parsePasswordHash(good)).not.toBeNull();
  });
  it.each([
    ["反復が 600000", good.replace("100000", "600000")],
    ["反復が 1000", good.replace("100000", "1000")],
    ["方式が違う", good.replace("pbkdf2-sha256", "pbkdf2-sha1")],
    ["salt が短い", "pbkdf2-sha256$100000$AAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["区切りが余る", `${good}$x`],
    ["空", ""],
  ])("🔴 %s → 読まない(ログインを全部断る側へ)", (_label, value) => {
    expect(parsePasswordHash(value)).toBeNull();
  });
  it("🔴 未設定 → 読まない", () => {
    expect(parsePasswordHash(undefined)).toBeNull();
  });
});

describe("時間差の出ない比較", () => {
  it("同じ → true / 1バイト違う → false / 長さが違う → false(例外を投げない)", () => {
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(false);
  });
});

describe("接続元(監査 M2)", () => {
  it.each([
    ["IPv4 はそのまま", "198.51.100.7", "198.51.100.7"],
    ["IPv6 は /64", "2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["省略形の IPv6 も /64", "2001:db8:1:2::9", "2001:db8:1:2::/64"],
    ["ヘッダが無い → unknown(厳しい側)", null, "unknown"],
    ["形が違う → unknown", "not-an-ip", "unknown"],
    ["カンマ区切り(複数)→ unknown", "198.51.100.7, 203.0.113.1", "unknown"],
  ])("%s", (_label, input, expected) => {
    expect(connectingAddress(input)).toBe(expected);
  });
});
