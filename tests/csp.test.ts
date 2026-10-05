// @vitest-environment node
//
// 管理画面の CSP(`scripts/csp.mjs`・`scripts/build-admin-headers.mjs`)の**判定そのもの**を固定する。
// 🔴 壊したら落ちる形にする: ハッシュは node:crypto で**独立に**計算した値と比較する(実装の
//   `scriptHashToken` を2回呼んで突き合わせるだけだと、実装が壊れても両辺が同じ壊れ方をして
//   気づけない——「検査が何も守っていない型」)。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCsp, collectScriptHashes, extractInlineScripts, scriptHashToken } from "../scripts/csp.mjs";
import { buildAdminHeadersFile, isSafeOrigin } from "../scripts/build-admin-headers.mjs";

function independentHashToken(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

describe("extractInlineScripts", () => {
  it("src を持つ script は無視し、持たない script の中身だけを取り出す", () => {
    const html = `<script src="/a.js" async></script><script>const x=1;</script><script type="module" src="/b.js"></script>`;
    expect(extractInlineScripts(html)).toEqual(["const x=1;"]);
  });

  it("複数のインライン script を順番どおりに全部取り出す", () => {
    const html = `<script>a</script><script src="/c.js"></script><script>b</script>`;
    expect(extractInlineScripts(html)).toEqual(["a", "b"]);
  });

  it("インライン script が無ければ空配列", () => {
    expect(extractInlineScripts(`<script src="/a.js"></script>`)).toEqual([]);
  });
});

describe("scriptHashToken", () => {
  it("'sha256-<base64>' の形。node:crypto で独立に計算した値と一致する", () => {
    const text = "console.log('adpop')";
    expect(scriptHashToken(text)).toBe(independentHashToken(text));
  });

  it("🔴 1バイトでも中身が変われば別のハッシュになる(固定値になっていないか)", () => {
    expect(scriptHashToken("a")).not.toBe(scriptHashToken("b"));
    expect(scriptHashToken("a")).toBe(independentHashToken("a"));
    expect(scriptHashToken("b")).toBe(independentHashToken("b"));
  });
});

describe("collectScriptHashes", () => {
  it("複数HTMLの重複ハッシュを1つにまとめ、決定的な順番(ソート済み)で返す", () => {
    const htmlA = `<script>same</script><script>onlyA</script>`;
    const htmlB = `<script>same</script>`;
    const hashes = collectScriptHashes([htmlA, htmlB]);
    expect(hashes).toHaveLength(2);
    expect(hashes).toEqual([independentHashToken("onlyA"), independentHashToken("same")].sort());
  });

  it("インラインscriptが1つも無ければ空配列", () => {
    expect(collectScriptHashes([`<script src="/a.js"></script>`])).toEqual([]);
  });
});

describe("buildCsp", () => {
  it("🔴 unsafe-inline・unsafe-eval・ワイルドカードを1つも含まない", () => {
    const csp = buildCsp({ scriptHashes: [scriptHashToken("x")], deliveryOrigin: "https://delivery.example.com" });
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/\*/);
  });

  it("配信元が無い(null)ときは img-src が 'self' だけ", () => {
    const csp = buildCsp({ scriptHashes: [], deliveryOrigin: null });
    expect(csp).toContain("img-src 'self'; connect-src");
  });

  it("配信元があれば img-src に足す", () => {
    const csp = buildCsp({ scriptHashes: [], deliveryOrigin: "https://delivery.example.com" });
    expect(csp).toContain("img-src 'self' https://delivery.example.com");
  });

  it("渡した script ハッシュがすべて script-src に入る", () => {
    const hashes = [scriptHashToken("a"), scriptHashToken("b")];
    const csp = buildCsp({ scriptHashes: hashes, deliveryOrigin: null });
    for (const h of hashes) expect(csp).toContain(h);
  });

  it("default-src 'none'・frame-ancestors 'none'・object-src 'none'・base-uri 'none' を持つ(骨格の固定)", () => {
    const csp = buildCsp({ scriptHashes: [], deliveryOrigin: null });
    for (const directive of ["default-src 'none'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
      expect(csp).toContain(directive);
    }
  });

  it("style-src・font-src は 'self' のみ(インラインの style 属性を許さない設計。globals.css 参照)", () => {
    const csp = buildCsp({ scriptHashes: [], deliveryOrigin: null });
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("font-src 'self'");
  });
});

describe("isSafeOrigin(fail-closed: ワイルドカード・非httpsは img-src に入れない)", () => {
  it("https://host の形は許す", () => {
    expect(isSafeOrigin("https://cdn.example.com")).toBe(true);
    expect(isSafeOrigin("https://cdn.example.com:8443")).toBe(true);
  });

  it("🔴 ワイルドカードは断る", () => {
    expect(isSafeOrigin("https://*.example.com")).toBe(false);
  });

  it("🔴 http(非TLS)は断る", () => {
    expect(isSafeOrigin("http://cdn.example.com")).toBe(false);
  });

  it("パス・クエリを含む値は断る(オリジンではない)", () => {
    expect(isSafeOrigin("https://cdn.example.com/path")).toBe(false);
    expect(isSafeOrigin("https://cdn.example.com?x=1")).toBe(false);
  });

  it("空文字は断る", () => {
    expect(isSafeOrigin("")).toBe(false);
  });
});

describe("buildAdminHeadersFile(_headers の中身)", () => {
  it("🔴 ワイルドカードを含む配信元は無視する(fail-closed。CSPが緩むより配信元が出ない方を選ぶ)", () => {
    const content = buildAdminHeadersFile({ htmlContents: [`<script>a</script>`], deliveryOrigin: "https://*.example.com" });
    expect(content).not.toContain("*.example.com");
    expect(content).toContain("img-src 'self';");
  });

  it("http(非TLS)の配信元は無視する", () => {
    const content = buildAdminHeadersFile({ htmlContents: [], deliveryOrigin: "http://insecure.example.com" });
    expect(content).not.toContain("insecure.example.com");
  });

  it("正しい https 配信元は img-src に入る", () => {
    const content = buildAdminHeadersFile({ htmlContents: [], deliveryOrigin: "https://cdn.example.com" });
    expect(content).toContain("img-src 'self' https://cdn.example.com");
  });

  it("全ルート(/*)の1ルールに、X-Content-Type-Options・Referrer-Policy・X-Frame-Options を含む", () => {
    const content = buildAdminHeadersFile({ htmlContents: [], deliveryOrigin: null });
    const lines = content.split("\n");
    expect(lines[0]).toBe("/*");
    expect(content).toContain("X-Content-Type-Options: nosniff");
    expect(content).toContain("Referrer-Policy: no-referrer");
    expect(content).toContain("X-Frame-Options: DENY");
  });

  it("🔴 渡したHTMLの実際のインラインscriptのハッシュが(独立計算と一致して)入る", () => {
    const html = `<script src="/x.js"></script><script>hello();</script>`;
    const content = buildAdminHeadersFile({ htmlContents: [html], deliveryOrigin: null });
    expect(content).toContain(independentHashToken("hello();"));
  });
});
