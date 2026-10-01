#!/usr/bin/env node
/*
  PR3b(管理画面の API・認証・画像)の守りに当てる変異の表。**1つずつ当てて、名指しした検査が赤くなることを見る。**
  使い方: `node scripts/mutate-pr3b.mjs`(全部)/ `node scripts/mutate-pr3b.mjs M1 A4`(名前の先頭で選ぶ)
  🔴 元に戻すのは**読み込んだ時点の中身**で行う(`git checkout` で戻さない = 未コミットの作業を消さない)。
  ⚠ 生き残った変異(GREEN)が1つでもあれば終了コード 1。
*/
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MUTATIONS = [
  {
    "name": "B1 変更系の Origin の検査を外す",
    "file": "src/admin/app.ts",
    "from": "if (origin === undefined || origin !== new URL(c.req.url).origin) return fail(c, 403, \"origin\");",
    "to": "",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B2 Sec-Fetch-Site の検査を外す",
    "file": "src/admin/app.ts",
    "from": "if (fetchSite !== undefined && fetchSite !== \"same-origin\") return fail(c, 403, \"fetch_site\");",
    "to": "",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B3 Content-Type の検査を外す",
    "file": "src/admin/app.ts",
    "from": "if (mediaType(c.req.header(\"content-type\")) !== expected) return fail(c, 415, \"content_type\");",
    "to": "",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B4 GET を認証の外にする",
    "file": "src/admin/app.ts",
    "from": "if ((PUBLIC_ROUTES as readonly string[]).includes(`${c.req.method.toUpperCase()} ${c.req.path}`)) return next();",
    "to": "if ((PUBLIC_ROUTES as readonly string[]).includes(`${c.req.method.toUpperCase()} ${c.req.path}`) || c.req.method === \"GET\") return next();",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B5 試行の上限 5→50",
    "file": "src/lib/data/auth.ts",
    "from": "export const LOGIN_ATTEMPTS_PER_WINDOW = 5;",
    "to": "export const LOGIN_ATTEMPTS_PER_WINDOW = 50;",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B6 接続元に X-Forwarded-For を使う",
    "file": "src/admin/app.ts",
    "from": "connectingAddress(c.req.header(\"cf-connecting-ip\") ?? null)",
    "to": "connectingAddress(c.req.header(\"x-forwarded-for\") ?? c.req.header(\"cf-connecting-ip\") ?? null)",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B7 IPv6 を /64 に丸めない",
    "file": "src/admin/crypto.ts",
    "from": "return expanded === null ? \"unknown\" : `${expanded.slice(0, 4).join(\":\")}::/64`;",
    "to": "return expanded === null ? \"unknown\" : expanded.join(\":\");",
    "tests": [
      "tests/admin-api.test.ts",
      "tests/admin-crypto.test.ts"
    ]
  },
  {
    "name": "B8 パスワードの指紋を見ない",
    "file": "src/admin/app.ts",
    "from": "      session.password_fingerprint === fingerprint &&\n",
    "to": "",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B9 設定の所有者を見ない(L6)",
    "file": "src/admin/app.ts",
    "from": "      session.owner_id === config.ownerId;",
    "to": "      true;",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B10 http なら常に Secure を外す",
    "file": "src/admin/cookie.ts",
    "from": "return url.protocol === \"http:\" && (host === \"localhost\" || host === \"127.0.0.1\" || host === \"::1\");",
    "to": "return url.protocol === \"http:\";",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B11 作成系の外部キーを 404 にしない(L3)",
    "file": "src/admin/app.ts",
    "from": "    case \"not_found\":\n    case \"foreign_key\":\n      return fail(c, 404, \"not_found\");",
    "to": "    case \"not_found\":\n      return fail(c, 404, \"not_found\");\n    case \"foreign_key\":\n      return fail(c, 400, \"foreign_key\");",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B12 本文の未知の鍵を許す",
    "file": "src/admin/body.ts",
    "from": "return actual.length === expected.length && actual.every((k, i) => k === expected[i]);",
    "to": "return expected.every((k) => actual.includes(k));",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B13 updateVariant が呼び出し側の content をそのまま入れる(M6)",
    "file": "src/lib/data/admin.ts",
    "from": ".bind(input.kind, textContent(input), input.destinationUrl, variantId, ownerId)",
    "to": ".bind(input.kind, JSON.stringify(input.content), input.destinationUrl, variantId, ownerId)",
    "tests": [
      "tests/d1-variant-content.test.ts"
    ]
  },
  {
    "name": "B14 JPEG の Exif を落とさない",
    "file": "src/lib/storage/image.ts",
    "from": "    if (marker !== 0xe1) parts.push(bytes.subarray(i, i + 2 + length));",
    "to": "    parts.push(bytes.subarray(i, i + 2 + length));",
    "tests": [
      "tests/image-check.test.ts",
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B15 画像を multipart でも受ける",
    "file": "src/admin/app.ts",
    "from": "const expected = isImageUpload(method, c.req.path) ? \"application/octet-stream\" : \"application/json\";",
    "to": "const expected = isImageUpload(method, c.req.path) ? (mediaType(c.req.header(\"content-type\")) === \"multipart/form-data\" ? \"multipart/form-data\" : \"application/octet-stream\") : \"application/json\";",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B17 全応答のヘッダを外す(M8)",
    "file": "src/admin/app.ts",
    "from": "    c.res.headers.set(\"Cache-Control\", \"no-store\");\n",
    "to": "",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B18 管理画面の呼び出しのログを残す(L11)",
    "file": "wrangler.admin.jsonc",
    "from": "\"invocation_logs\": false",
    "to": "\"invocation_logs\": true",
    "tests": [
      "tests/admin-config.test.ts"
    ]
  },
  {
    "name": "B19 反復回数 600000 のハッシュも読む",
    "file": "src/admin/crypto.ts",
    "from": "const HASH_PATTERN = /^pbkdf2-sha256\\$100000\\$",
    "to": "const HASH_PATTERN = /^pbkdf2-sha256\\$(?:100000|600000)\\$",
    "tests": [
      "tests/admin-crypto.test.ts",
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B20 セッションの所有者を書き換えられる",
    "file": "db/migrations/0002_admin_auth.sql",
    "from": "when new.token_hash is not old.token_hash or new.owner_id is not old.owner_id",
    "to": "when new.token_hash is not old.token_hash",
    "tests": [
      "tests/d1-replace.test.ts"
    ]
  },
  {
    "name": "B21 配信の Worker が書き込みの images.ts を読む",
    "file": "src/delivery/worker.ts",
    "from": "import { readImage } from \"../lib/data/image-read\";",
    "to": "import { readImage } from \"../lib/data/image-read\";\nimport * as writeImages from \"../lib/data/images\";\nvoid writeImages;",
    "tests": [
      "tests/delivery-imports.test.ts"
    ]
  },
  {
    "name": "B22 マイグレーション 0002 で既存のトリガを弱める",
    "file": "db/migrations/0002_admin_auth.sql",
    "from": "create table admin_sessions (",
    "to": "drop trigger sites_limit;\ncreate trigger sites_limit before insert on sites when 0 begin select raise(abort, 'adpop:limit:sites'); end;\n\ncreate table admin_sessions (",
    "tests": [
      "tests/d1-migration-additive.test.ts"
    ]
  },
  {
    "name": "B23 ログイン失敗の本文をログに出す",
    "file": "src/admin/app.ts",
    "from": "    if (!(emailOk && passwordOk)) return fail(c, 401, \"invalid_credentials\");",
    "to": "    if (!(emailOk && passwordOk)) {\n      console.error(\"[adpop-admin] login failed\", parsed.value);\n      return fail(c, 401, \"invalid_credentials\");\n    }",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B16 パターンを消すときに R2 の画像を消さない(L2)",
    "file": "src/lib/data/images.ts",
    "from": "  const deleted = await admin.deleteVariant(env, ownerId, variantId);\n  if (!deleted.ok) return deleted;\n  return { ok: true, value: { imagesLeft: await deleteQuietly(env, keys.value) } };",
    "to": "  const deleted = await admin.deleteVariant(env, ownerId, variantId);\n  if (!deleted.ok) return deleted;\n  return { ok: true, value: { imagesLeft: 0 } };",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  }
];

const picked = process.argv.slice(2);
let survived = 0;
for (const m of MUTATIONS) {
  if (picked.length > 0 && !picked.includes(m.name.split(" ")[0])) continue;
  const file = path.join(ROOT, m.file);
  const original = readFileSync(file, "utf8");
  if (original.split(m.from).length !== 2) {
    console.log(`!! ${m.name}: 置換対象がちょうど1件ではない`);
    survived += 1;
    continue;
  }
  writeFileSync(file, original.replace(m.from, m.to));
  try {
    const r = spawnSync("npx", ["vitest", "run", ...m.tests], { cwd: ROOT, encoding: "utf8" });
    const red = r.status !== 0;
    if (!red) survived += 1;
    console.log(`${red ? "RED " : "GREEN(生存)"} ${m.name}`);
  } finally {
    writeFileSync(file, original);
  }
}
process.exit(survived === 0 ? 0 : 1);
