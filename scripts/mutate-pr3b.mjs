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
    "name": "B16 削除のときに R2 の画像を消さない(L2)",
    "file": "src/lib/data/images.ts",
    "from": "  await deleteOrEnqueue(env, ownerId, keys.value);\n  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };",
    "to": "  return { ok: true, value: { cleanupPending: await pendingCount(env, ownerId) } };",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B24 寸法の上限 2,400→2,401",
    "file": "src/lib/storage/image.ts",
    "from": "export const MAX_IMAGE_SIDE = 2400;",
    "to": "export const MAX_IMAGE_SIDE = 2401;",
    "tests": [
      "tests/image-check.test.ts",
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "B25 寸法を読めない画像を通す",
    "file": "src/lib/storage/image.ts",
    "from": "  if (size === null || size.width === 0 || size.height === 0) return { ok: false, reason: \"corrupt\" };\n  if (Math.max(size.width, size.height) > MAX_IMAGE_SIDE)",
    "to": "  if (size !== null && Math.max(size.width, size.height) > MAX_IMAGE_SIDE)",
    "tests": [
      "tests/image-check.test.ts"
    ]
  },
  {
    "name": "B26 JPEG の寸法を幅と高さを取り違えて読む",
    "file": "src/lib/storage/image.ts",
    "from": "if (isSof) return { width: u16be(bytes, i + 7), height: u16be(bytes, i + 5) };",
    "to": "if (isSof) return { width: u16be(bytes, i + 5), height: u16be(bytes, i + 5) };",
    "tests": [
      "tests/image-check.test.ts"
    ]
  },
  {
    "name": "C1 置いた後の例外で新しいキーを消さない(#7 Blocker 1)",
    "file": "src/lib/data/images.ts",
    "from": "    // 🔴 置いたかもしれない新しいキーを消す(消せなければ積む)。元の例外はそのまま投げる\n    await deleteOrEnqueue(env, ownerId, [key]);\n    throw error;",
    "to": "    throw error;",
    "tests": [
      "tests/d1-images-failure.test.ts"
    ]
  },
  {
    "name": "C2 消せなかったキーを積まない(#7 Blocker 2)",
    "file": "src/lib/data/images.ts",
    "from": "  if (failed.length > 0) await enqueue(env, ownerId, failed);",
    "to": "",
    "tests": [
      "tests/d1-images-failure.test.ts",
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "C3 積んだキーを消し直さない",
    "file": "src/lib/data/images.ts",
    "from": "      if (isImageKey(key)) await resolveImages(env).delete(key);\n",
    "to": "",
    "tests": [
      "tests/d1-images-failure.test.ts",
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "C4 消し直しが所有者を見ない",
    "file": "src/lib/data/images.ts",
    "from": "    .prepare(`select key from pending_image_deletions where owner_id = ?1 order by created_at, key limit ?2`)",
    "to": "    .prepare(`select key from pending_image_deletions where ?1 is not null order by created_at, key limit ?2`)",
    "tests": [
      "tests/d1-owner-isolation.test.ts"
    ]
  },
  {
    "name": "C5 応答に cleanupPending を載せない",
    "file": "src/admin/app.ts",
    "from": "  return c.json({ ok: true, data: { cleanupPending: result.value.cleanupPending } });",
    "to": "  return c.json({ ok: true, data: null });",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "C6 上限の判定を PBKDF2 の後ろへ動かす(M1)",
    "file": "src/admin/app.ts",
    "from": "    if (attempts > auth.LOGIN_ATTEMPTS_PER_WINDOW) return fail(c, 429, \"too_many_attempts\");\n    // 🔴 メールの正否にかかわらず PBKDF2 を1回回す(時間差でメールの正否を分からせない・監査 L7)\n    const derived = await pbkdf2(parsed.value.password, config.passwordHash.salt);",
    "to": "    // 🔴 メールの正否にかかわらず PBKDF2 を1回回す(時間差でメールの正否を分からせない・監査 L7)\n    const derived = await pbkdf2(parsed.value.password, config.passwordHash.salt);\n    if (attempts > auth.LOGIN_ATTEMPTS_PER_WINDOW) return fail(c, 429, \"too_many_attempts\");",
    "tests": [
      "tests/admin-api.test.ts"
    ]
  },
  {
    "name": "C7 ログインを試みたときにセッションを掃除しない",
    "file": "src/admin/app.ts",
    "from": "    await auth.purgeExpiredSessions(c.env, config.ownerId, t, IDLE_TIMEOUT_MS);\n",
    "to": "",
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
