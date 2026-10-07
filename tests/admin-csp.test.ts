// @vitest-environment node
//
// 🔴 **CSP が実際に効いているかを、実物の Worker から確かめる**(ヘッダの有無だけでなく、実際に
//   served された HTML のインラインscriptのハッシュが CSP に入っているかまで見る)。
//   `scripts/csp.mjs`・`tests/csp.test.ts` は生成ロジックの**単体**検査(壊れたら落ちる形)。
//   こちらは「本当に `out/_headers` が作られ、管理画面の Worker の静的配信がそれを返しているか」
//   という**配線**の検査(`tests/d1-worker-runtime.test.ts` と同じ考え方: 実物の workerd で起動して外から叩く)。
//
// 🔴 期待するハッシュは、`scripts/csp.mjs` を再利用せず **この検査ファイルの中で node:crypto から
//   独立に計算する**。同じ関数を2回呼んで突き合わせるだけだと、生成ロジック自体が壊れても
//   両辺が同じ壊れ方をして気づけない(「検査が何も守っていない型」)。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { REPO_ROOT } from "../scripts/build-admin-headers.mjs";
import { ADMIN_WRANGLER_PATH, createTestWorkerConfig } from "./helpers/wrangler-config";

const DELIVERY_ORIGIN_FOR_TEST = "https://adpop-delivery.example-test.workers.dev";

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

function independentScriptHashes(html: string): Set<string> {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const hashes = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    hashes.add(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
  }
  return hashes;
}

/**
 * CSP の1ディレクティブの値を、空白区切りのトークンに分ける(`scripts/csp.mjs` を再利用せず、
 * この検査ファイルの中で独立に実装する。同じパーサを2回使うと生成ロジックが壊れても気づけない)。
 * CSP Level 3 のスキームソース(`blob:` 等)は完全一致で判定されるので、部分文字列ではなく
 * トークンの完全一致で見る(`https://blob:evil.example` のような文字列に誤って一致しない)。
 */
function directiveTokens(csp: string, name: string): string[] {
  const directive = csp.split("; ").find((d) => d.startsWith(`${name} `));
  if (directive === undefined) return [];
  return directive.slice(name.length + 1).split(" ");
}

let testConfig: ReturnType<typeof createTestWorkerConfig>;

beforeAll(async () => {
  // 🔴 実物の `next build` を実際に走らせてから `_headers` を作る(手で書いた値・固定した
  //   サンプルHTMLではなく、ビルドが実際に出す HTML を検査する)。
  const env = { ...process.env, NEXT_PUBLIC_DELIVERY_ORIGIN: DELIVERY_ORIGIN_FOR_TEST };
  execFileSync("npx", ["next", "build"], { cwd: REPO_ROOT, env, stdio: "pipe" });
  execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts/build-admin-headers.mjs")], { cwd: REPO_ROOT, env, stdio: "pipe" });

  // 🔴 本物の `wrangler.admin.jsonc` は一切書き換えない。`build.command`(deploy 前の検査を含む)は
  //   `wrangler dev`/`unstable_startWorker` でも走る(Wrangler の仕様)が、この検査は本物の
  //   `wrangler.admin.jsonc`(workers_dev: false・routes: [custom domain])をそのまま
  //   `unstable_startWorker` に渡すと、ローカル開発サーバでも Custom Domain の検査
  //   (`scripts/check-custom-domain.mjs`)等がそのまま走って本題と関係ない理由で詰まる(本番の
  //   D1 は作成済み・docs/deploy.md §2。配信元もこの PR で確定済み・docs/deploy.md §5)。
  //   この検査自体は `tests/admin-config.test.ts`・`tests/delivery-origin-guard.test.ts` で
  //   別途固定済みなので、ここでは `build` フィールドを外した一時ファイルを使い、
  //   `unstable_startWorker` がカスタムビルドを一切起動しないようにする(省略する「経路」を検査
  //   スクリプト自身には持たせず、この worker はそもそも検査を呼ばない設定で動かす)。
  //   `out/` は直前の明示的な build 呼び出しで既に正しい内容になっている。
  testConfig = createTestWorkerConfig(ADMIN_WRANGLER_PATH);

  worker = await unstable_startWorker({
    config: testConfig.path,
    dev: { server: { port: 0 }, inspector: false, logLevel: "none", watch: false },
  });
  await worker.ready;
}, 180_000);

afterAll(async () => {
  await worker?.dispose();
  testConfig?.cleanup();
});

describe("管理画面の Worker(workerd で起動)が返す CSP", () => {
  it("🔴 静的ページの応答に CSP が付き、unsafe-inline/unsafe-eval/ワイルドカードが無い", async () => {
    const response = await worker.fetch("http://adpop.test/sites");
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/[a-z-]+-src[^;]*\*/);
  });

  it("🔴 このページの実際のインラインscriptのハッシュ(独立計算)が、served CSP にすべて入っている", async () => {
    const response = await worker.fetch("http://adpop.test/sites");
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    const expected = independentScriptHashes(html);
    expect(expected.size).toBeGreaterThan(0); // 前提: このページにインラインscriptが実在する
    for (const hash of expected) {
      expect(csp).toContain(hash);
    }
  });

  it("🔴 配信元(NEXT_PUBLIC_DELIVERY_ORIGIN)が img-src に入っている(サムネイルを読める)", async () => {
    const response = await worker.fetch("http://adpop.test/sites");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`img-src 'self' blob: ${DELIVERY_ORIGIN_FOR_TEST}`);
  });

  it("🔴 Codex r1 Blocker: img-src に blob: がトークンとして完全一致で入っている(新規画像パターンの URL.createObjectURL() プレビューが CSP で断られないため)。blob: を外したら落ちる", async () => {
    const response = await worker.fetch("http://adpop.test/popup");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(directiveTokens(csp, "img-src")).toContain("blob:");
    // 用途を画像だけに限定する(script-src・connect-src には blob: を足さない)
    expect(directiveTokens(csp, "script-src")).not.toContain("blob:");
    expect(directiveTokens(csp, "connect-src")).not.toContain("blob:");
  });

  it("font-src 'self' が入っている(public/fonts/ の自前ホストフォントが読める。default-src 'none' だけでは断られる)", async () => {
    const response = await worker.fetch("http://adpop.test/sites");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("font-src 'self'");
  });

  it("nosniff・no-referrer・DENY が付く", async () => {
    const response = await worker.fetch("http://adpop.test/sites");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("ページが違えば中身(インラインscriptの中身)も違いうるが、名前のある5ルート(/, /login, /popup, /site, /sites)はどれも自分のハッシュが served CSP に入る(⚠ _not-found/404 は未検査)", async () => {
    for (const p of ["/", "/login", "/popup", "/site", "/sites"]) {
      const response = await worker.fetch(`http://adpop.test${p}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const csp = response.headers.get("content-security-policy") ?? "";
      for (const hash of independentScriptHashes(html)) {
        expect(csp, `page ${p} の script ハッシュが CSP に無い`).toContain(hash);
      }
    }
  });
});
