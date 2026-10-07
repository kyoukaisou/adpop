// @vitest-environment node
//
// 配信の Worker のエラーの1行が**匿名化**されていること(レビュー指摘)。
// ⚠ 測っているのは「こちらが用意した形を伏せる」ことだけ。伏せ漏れが無いことの保証ではない(log.ts の冒頭)。
import { afterEach, describe, expect, it, vi } from "vitest";
import { logFailure, redact } from "../src/lib/log/redact";
import { readDeliveryWranglerConfig } from "./helpers/wrangler-config";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("エラーの1行の匿名化", () => {
  it.each([
    ["IPv4", "connect failed to 203.0.113.7:443", "203.0.113.7"],
    ["IPv6", "from 2001:db8::1 refused", "2001:db8::1"],
    ["URL", "fetch https://lp.example.com/a?email=taro%40example.com failed", "lp.example.com"],
    ["引用符の中", `near "taro@example.com": syntax error`, "taro@example.com"],
    ["サイトキーの形", "site 0123456789abcdef0123456789abcdef missing", "0123456789abcdef"],
  ])("🔴 %s を伏せる", (_label, message, secret) => {
    expect(redact(message)).not.toContain(secret);
  });

  it("✅ 失敗の種類は残る(伏せすぎていない)", () => {
    expect(redact("D1_ERROR: Network connection lost")).toBe("D1_ERROR: Network connection lost");
  });

  it("🔴 console に出るのは伏せた1行", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFailure("events", new Error("D1_ERROR: bad value '198.51.100.9'"));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe("[adpop] events failed: Error: D1_ERROR: bad value <quoted>");
  });
});

describe("Cloudflare に残すログの設定", () => {
  it("🔴 配信の Worker は呼び出しのログ(invocation logs)を残さない", () => {
    const config = readDeliveryWranglerConfig() as { observability?: { logs?: { invocation_logs?: boolean } } };
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });
});
