#!/usr/bin/env node
/*
  PR3a(D1 への移行)の守りに当てる変異の表。**1つずつ当てて、名指しした検査が赤くなることを見る。**
  使い方: `node scripts/mutate-pr3a.mjs`(全部)/ `node scripts/mutate-pr3a.mjs M1 A4`(名前の先頭で選ぶ)
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
    "name": "M1 サイト上限 20→21",
    "file": "db/migrations/0001_schema.sql",
    "from": ">= 20\nbegin\n  select raise(abort, 'adpop:limit:sites');",
    "to": ">= 21\nbegin\n  select raise(abort, 'adpop:limit:sites');",
    "tests": [
      "tests/d1-limits.test.ts",
      "tests/d1-semantics.test.ts"
    ]
  },
  {
    "name": "M2 ポップ戻しの上限トリガを外す",
    "file": "db/migrations/0001_schema.sql",
    "from": "when old.archived_at is not null and new.archived_at is null\n  and (select count(*) from popups",
    "to": "when 0 and old.archived_at is not null and new.archived_at is null\n  and (select count(*) from popups",
    "tests": [
      "tests/d1-limits.test.ts"
    ]
  },
  {
    "name": "M3 パターン上限がアーカイブ済みも数える",
    "file": "db/migrations/0001_schema.sql",
    "from": "(select count(*) from variants where popup_id = new.popup_id and archived_at is null) >= 5\nbegin\n  select raise(abort, 'adpop:limit:variantsPerPopup');\nend;\n\ncreate trigger variants_limit_restore",
    "to": "(select count(*) from variants where popup_id = new.popup_id) >= 5\nbegin\n  select raise(abort, 'adpop:limit:variantsPerPopup');\nend;\n\ncreate trigger variants_limit_restore",
    "tests": [
      "tests/d1-limits.test.ts"
    ]
  },
  {
    "name": "M4 稼働中は1つ の一意索引を外す",
    "file": "db/migrations/0001_schema.sql",
    "from": "create unique index popups_one_active_per_site on popups (site_id) where status = 'active';",
    "to": "create index popups_one_active_per_site on popups (site_id) where status = 'active';",
    "tests": [
      "tests/d1-schema.test.ts",
      "tests/d1-semantics.test.ts"
    ]
  },
  {
    "name": "M5 親の付け替えの禁止を外す",
    "file": "db/migrations/0001_schema.sql",
    "from": "when new.id is not old.id or new.owner_id is not old.owner_id\n  or new.site_id is not old.site_id or new.public_key is not old.public_key",
    "to": "when new.id is not old.id or new.owner_id is not old.owner_id\n  or new.public_key is not old.public_key",
    "tests": [
      "tests/d1-schema.test.ts"
    ]
  },
  {
    "name": "M6 page_url のホストの @ 検査を外す",
    "file": "db/migrations/0001_schema.sql",
    "from": "            '@') = 0",
    "to": "            '@') >= 0",
    "tests": [
      "tests/d1-schema.test.ts"
    ]
  },
  {
    "name": "A1 getSite から所有者の条件を外す",
    "file": "src/lib/data/admin.ts",
    "from": "select id, name, site_key from sites where id = ?1 and owner_id = ?2`)\n    .bind(siteId, ownerId)",
    "to": "select id, name, site_key from sites where id = ?1 and ?2 is not null`)\n    .bind(siteId, ownerId)",
    "tests": [
      "tests/d1-owner-isolation.test.ts"
    ]
  },
  {
    "name": "A2 updateVariant から所有者の条件を外す",
    "file": "src/lib/data/admin.ts",
    "from": "destination_url = ?3, updated_at = ${NOW}\n         where id = ?4 and owner_id = ?5",
    "to": "destination_url = ?3, updated_at = ${NOW}\n         where id = ?4 and ?5 is not null",
    "tests": [
      "tests/d1-owner-isolation.test.ts"
    ]
  },
  {
    "name": "A3 listVariants から所有者の条件を外す",
    "file": "src/lib/data/admin.ts",
    "from": "from variants where popup_id = ?1 and owner_id = ?2 order by",
    "to": "from variants where popup_id = ?1 and ?2 is not null order by",
    "tests": [
      "tests/d1-owner-isolation.test.ts"
    ]
  },
  {
    "name": "A4 activate の1文目から条件を外す",
    "file": "src/lib/data/admin.ts",
    "from": "and site_id = (select site_id from popups where id = ?1 and owner_id = ?2)\n             and exists (${eligible})",
    "to": "and site_id = (select site_id from popups where id = ?1 and owner_id = ?2)",
    "tests": [
      "tests/d1-activate.test.ts"
    ]
  },
  {
    "name": "A5 公開関数を足したのに撃ち方を書かない",
    "file": "src/lib/data/admin.ts",
    "from": "export function archiveVariant(",
    "to": "export function leakAll(db: D1Database, ownerId: string) { return db.prepare(`select * from sites`).bind(ownerId).all(); }\n\nexport function archiveVariant(",
    "tests": [
      "tests/d1-owner-isolation.test.ts"
    ]
  },
  {
    "name": "W1 Worker から D1 を直接呼ぶ",
    "file": "src/delivery/worker.ts",
    "from": "  return route === \"config\" ? handleConfig",
    "to": "  await env.DB.prepare(\"select 1\").first();\n  return route === \"config\" ? handleConfig",
    "tests": [
      "tests/d1-access-boundary.test.ts"
    ]
  },
  {
    "name": "D1 投入で許可ドメインの照合を外す",
    "file": "src/lib/data/delivery.ts",
    "from": "       join site_allowed_origins o on o.site_id = s.id and o.origin = ?2\n       where s.site_key = ?1`,\n    )\n    .bind(siteKey, origin)\n    .first<{ id: string; owner_id: string }>();",
    "to": "       where s.site_key = ?1 and ?2 is not null`,\n    )\n    .bind(siteKey, origin)\n    .first<{ id: string; owner_id: string }>();",
    "tests": [
      "tests/d1-delivery.test.ts"
    ]
  },
  {
    "name": "D2 配れる条件から kind を外す",
    "file": "src/lib/data/delivery.ts",
    "from": "export const DELIVERABLE_VARIANT = \"archived_at is null and kind = 'text'\";",
    "to": "export const DELIVERABLE_VARIANT = \"archived_at is null and kind <> 'chatbot'\";",
    "tests": [
      "tests/d1-delivery.test.ts",
      "tests/d1-activate.test.ts"
    ]
  },
  {
    "name": "D3 page_url の query を削らない",
    "file": "src/lib/data/shapes.ts",
    "from": "  const cut = trimmed.split(\"#\")[0].split(\"?\")[0];",
    "to": "  const cut = trimmed;",
    "tests": [
      "tests/d1-delivery.test.ts"
    ]
  },
  {
    "name": "D4 値が文字列かの検査を外す",
    "file": "src/lib/data/delivery.ts",
    "from": "  if (Object.values(event).some((value) => typeof value !== \"string\")) return { ok: false, reason: \"types\" };",
    "to": "",
    "tests": [
      "tests/d1-delivery.test.ts"
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
