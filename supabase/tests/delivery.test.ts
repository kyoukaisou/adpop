// @vitest-environment node
//
// 配信の関数2本(0003)の回帰テスト。PGlite にマイグレーションを通しで流して測る。
//
// 🔴 **この束がいちばん守りたいもの**:
//   ① **anon は業務テーブルに1バイトも触れないまま、この2本だけを呼べる**(要件書 §5-3)
//      → 呼ぶのは全部 `set role anon` から。**postgres で呼んで緑にしない。**
//   ② **fail-closed**(要件書 §5-3 / §6-5): サイトキー・Origin・許可ドメインのどれか1つでも
//      合わなければ**何も返さない・何も書かない**
//   ③ **返す情報が最小**: 内部 id・`owner_id`・他サイト・他ポップの情報を**1バイトも返さない**
//   ④ **`page_url` は origin + path だけ**(要件書 §6 裁定4)。**投入側が削ってから入れる**
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const ORIGIN_A = "https://lp.example.com";
const ORIGIN_B = "https://other.example.com";

const AUTH_STUB = `
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create role anon;
  create role authenticated;
  create role service_role nobypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  insert into auth.users (id, email) values
    ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test');
`;

type Config = {
  v: number;
  popup: {
    key: string;
    minDisplayDelaySeconds: number;
    frequency: { suppressDays: number; sessionImpressions: number; postConversionDays: number };
    triggers: Array<{ kind: string; threshold: number | null }>;
    variants: Array<{
      key: string;
      kind: string;
      weight: number;
      content: Record<string, unknown>;
      destinationUrl: string;
    }>;
  };
} | null;

type EventResult = { ok: boolean; stored?: boolean; reason?: string };

let db: PGlite;
/** 表に置いた行の内部 id / 公開用の識別子。**公開用しか関数へ渡さない。** */
const ref = {
  siteKeyA: "",
  siteKeyB: "",
  siteKeyEmptyOrigins: "",
  siteKeyNoActive: "",
  popupKeyA: "",
  popupKeyB: "",
  variantKeyA: "",
  variantKeyA2: "",
  variantKeyB: "",
  siteIdA: "",
  popupIdA: "",
};

async function asOwner(owner: string, sql: string): Promise<void> {
  await db.exec(`set request.jwt.claims = '${JSON.stringify({ sub: owner, role: "authenticated" })}';
                 set role authenticated;`);
  try {
    await db.exec(sql);
  } finally {
    await db.exec("reset role; reset request.jwt.claims;");
  }
}

/**
 * 🔴 **必ず `anon` として呼ぶ。** postgres のまま呼ぶと
 *   「権限が配られているか」を1ミリも測らないまま緑になる。
 */
async function callAsAnon<T>(sql: string, params: unknown[]): Promise<T> {
  await db.exec("set role anon;");
  try {
    const r = await db.query<{ out: T }>(sql, params);
    return r.rows[0].out;
  } finally {
    await db.exec("reset role;");
  }
}

const config = (siteKey: string, origin: string) =>
  callAsAnon<Config>(`select public.adpop_site_config($1, $2) as out`, [siteKey, origin]);

const record = (siteKey: string, origin: string, event: Record<string, unknown>) =>
  callAsAnon<EventResult>(`select public.adpop_record_event($1, $2, $3::jsonb) as out`, [
    siteKey,
    origin,
    JSON.stringify(event),
  ]);

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(AUTH_STUB);
  // Supabase の既定privilege を再現(0001 が剥がせているかを、ここでも同じ前提から測る)
  await db.exec(`grant all on schema public to anon, authenticated, service_role;
                 alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
                 alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
                 alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  await asOwner(
    USER_A,
    `insert into public.sites (owner_id, name, allowed_origins) values
       ('${USER_A}', 'A の LP',   array['${ORIGIN_A}']),
       ('${USER_A}', '許可空',     '{}'),
       ('${USER_A}', 'active無し', array['${ORIGIN_A}']);`,
  );
  await asOwner(
    USER_B,
    `insert into public.sites (owner_id, name, allowed_origins) values
       ('${USER_B}', 'B の LP', array['${ORIGIN_B}']);`,
  );
  const sites = await db.query<{ id: string; name: string; site_key: string }>(
    `select id, name, site_key from public.sites`,
  );
  const siteBy = (name: string) => sites.rows.find((row) => row.name === name)!;
  ref.siteKeyA = siteBy("A の LP").site_key;
  ref.siteIdA = siteBy("A の LP").id;
  ref.siteKeyB = siteBy("B の LP").site_key;
  ref.siteKeyEmptyOrigins = siteBy("許可空").site_key;
  ref.siteKeyNoActive = siteBy("active無し").site_key;

  await asOwner(
    USER_A,
    `insert into public.popups (owner_id, site_id, name, status) values
       ('${USER_A}', '${ref.siteIdA}', 'A の active', 'active');
     insert into public.popups (owner_id, site_id, name, status) values
       ('${USER_A}', '${siteBy("許可空").id}', '許可空の active', 'active');
     insert into public.popups (owner_id, site_id, name, status) values
       ('${USER_A}', '${siteBy("active無し").id}', '下書き', 'draft');`,
  );
  await asOwner(
    USER_B,
    `insert into public.popups (owner_id, site_id, name, status) values
       ('${USER_B}', '${siteBy("B の LP").id}', 'B の active', 'active');`,
  );
  const popups = await db.query<{ id: string; name: string; public_key: string }>(
    `select id, name, public_key from public.popups`,
  );
  const popupBy = (name: string) => popups.rows.find((row) => row.name === name)!;
  ref.popupKeyA = popupBy("A の active").public_key;
  ref.popupIdA = popupBy("A の active").id;
  ref.popupKeyB = popupBy("B の active").public_key;

  await asOwner(
    USER_A,
    `insert into public.variants (owner_id, popup_id, kind, weight, content, destination_url) values
       ('${USER_A}', '${ref.popupIdA}', 'text', 60, '{"headline":"まだ間に合います"}', 'https://offer.example.com/a'),
       ('${USER_A}', '${ref.popupIdA}', 'text', 40, '{"headline":"もう1つの案"}',     'https://offer.example.com/b');
     insert into public.variants (owner_id, popup_id, destination_url) values
       ('${USER_A}', '${popupBy("許可空の active").id}', 'https://offer.example.com/x');`,
  );
  await asOwner(
    USER_B,
    `insert into public.variants (owner_id, popup_id, destination_url) values
       ('${USER_B}', '${popupBy("B の active").id}', 'https://offer.example.com/bb');`,
  );
  const variants = await db.query<{ id: string; public_key: string; destination_url: string }>(
    `select id, public_key, destination_url from public.variants`,
  );
  const variantBy = (url: string) => variants.rows.find((row) => row.destination_url === url)!;
  ref.variantKeyA = variantBy("https://offer.example.com/a").public_key;
  ref.variantKeyA2 = variantBy("https://offer.example.com/b").public_key;
  ref.variantKeyB = variantBy("https://offer.example.com/bb").public_key;
});

afterAll(async () => {
  await db?.close();
});

/*
  ══════════════════════════════════════════════════════════════════════════
  0. 前提の検算 —— **anon として呼べていること**を先に確かめる
  ══════════════════════════════════════════════════════════════════════════
  🔴 これが無いと、下の「断られた」が全部
    「そもそも呼べていないので断られた」でも緑になる(被験体の取り違え)。
*/
describe("前提: anon から呼べていて、表には1バイトも届かない", () => {
  it("anon として設定を取得できる(= 権限が配られている)", async () => {
    const c = await config(ref.siteKeyA, ORIGIN_A);
    expect(c, "anon から設定が取れない = 以下の fail-closed の検査は全部空回りする").not.toBeNull();
  });

  it("同じ anon が業務テーブルには届かない(42501)", async () => {
    for (const table of ["sites", "popups", "variants", "events"]) {
      await db.exec("set role anon;");
      let code = "";
      try {
        await db.query(`select * from public.${table} limit 1`);
      } catch (e) {
        code = (e as { code?: string }).code ?? "unknown";
      }
      await db.exec("reset role;");
      expect(code, `anon が ${table} を読めた`).toBe("42501");
    }
  });
});

describe("配信: adpop_site_config", () => {
  it("✅ 許可ドメインから引くと、いま有効なポップの設定が返る", async () => {
    const c = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(c.v).toBe(1);
    expect(c.popup.key).toBe(ref.popupKeyA);
    expect(c.popup.minDisplayDelaySeconds).toBe(3);
    expect(c.popup.frequency).toEqual({
      suppressDays: 7,
      sessionImpressions: 1,
      postConversionDays: 30,
    });
  });

  it("🔴 内部 id・owner_id・他サイトの情報を1バイトも返さない", async () => {
    /*
      🔴 **列名で見ない。** 返した JSON を**文字列にして**、外に出てはいけない値が
        1つも含まれないことを見る —— 入れ子のどこに紛れても落ちる形にするため。
    */
    const c = await config(ref.siteKeyA, ORIGIN_A);
    const raw = JSON.stringify(c);
    for (const [label, secret] of [
      ["owner_id", USER_A],
      ["site の内部 id", ref.siteIdA],
      ["popup の内部 id", ref.popupIdA],
      ["他サイトの公開キー", ref.siteKeyB],
      ["他サイトのポップ", ref.popupKeyB],
      ["他サイトのバリアント", ref.variantKeyB],
    ] as const) {
      expect(raw.includes(secret), `${label} が配信の応答に混ざっている`).toBe(false);
    }
    // ⚠ `owner` を含む鍵が1つも無いこと(将来だれかが足したら落ちる)
    expect(raw).not.toMatch(/owner/i);
  });

  it("有効なトリガだけが、既定値(要件書 §4-2)のまま返る", async () => {
    const c = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect(c.popup.triggers).toEqual([
      { kind: "back", threshold: null },
      { kind: "exit_intent", threshold: null },
    ]);
  });

  it("バリアントは重みと中身つきで、**決定的な順序**で返る(割り当ては PR5)", async () => {
    /*
      🔴 **「作った順」とは書かない**(2026-09-09 実測)。
        `created_at` の既定は `now()` = **トランザクションの開始時刻**なので、
        **同じトランザクションで作った複数行は created_at が同値**になり、
        並びは第2キーの `id`(乱数の uuid)で決まる。
        → 保証できるのは「**毎回同じ順で返る**」ことだけ。
        ⚠ PR2 の埋め込みスクリプトは**先頭の1つ**を使うので、ここが決定的でないと
          同じ訪問者に違うバリアントが出る(§4-5「割り当ては訪問者単位で固定」に反する)。
    */
    const first = (await config(ref.siteKeyA, ORIGIN_A))!;
    const second = (await config(ref.siteKeyA, ORIGIN_A))!;
    expect([...first.popup.variants.map((v) => v.key)].sort()).toEqual(
      [ref.variantKeyA, ref.variantKeyA2].sort(),
    );
    expect(second.popup.variants.map((v) => v.key)).toEqual(first.popup.variants.map((v) => v.key));

    const a = first.popup.variants.find((v) => v.key === ref.variantKeyA);
    expect(a).toEqual({
      key: ref.variantKeyA,
      kind: "text",
      weight: 60,
      content: { headline: "まだ間に合います" },
      destinationUrl: "https://offer.example.com/a",
    });
  });

  describe("🔴 fail-closed(1つでも合わなければ null)", () => {
    it.each([
      ["許可していない Origin", () => config(ref.siteKeyA, ORIGIN_B)],
      ["Origin の形が違う", () => config(ref.siteKeyA, "https://lp.example.com/path")],
      ["Origin が空文字", () => config(ref.siteKeyA, "")],
      ["サイトキーの形が違う", () => config("not-a-site-key", ORIGIN_A)],
      ["実在しないサイトキー", () => config("0".repeat(32), ORIGIN_A)],
      // ⚠ **単独では観測できない**(0003 のコメント参照)。 が空配列に偽を返すので、
      //   「空 = 全許可にしない」の1文を消しても、この行は緑のまま通る。**測れているのは合成の結果だけ。**
      /*
        ⚠ **この行は「空 = 全許可にしない」の1文を単独では測っていない**(2026-09-09 の変異検査)。
          空配列に対して `p_origin = any('{}')` は偽なので、**その1文を消しても緑のまま通る**。
          測れているのは**合成の結果**(空のサイトには返らない)だけ。0003 のコメントに同じことを書いた。
      */
      ["許可ドメインが空のサイト", () => config(ref.siteKeyEmptyOrigins, ORIGIN_A)],
      ["active なポップが無いサイト", () => config(ref.siteKeyNoActive, ORIGIN_A)],
    ])("%s → null", async (_label, run) => {
      expect(await run()).toBeNull();
    });

    it("⚠ 「サイトが無い」と「Origin が違う」は呼び出し側から区別できない", async () => {
      /*
        区別できると、**総当たりで実在するサイトキーだけを選り分けられる**。
        ⚠ ここが測っているのは「どちらも null」であること。
          応答時間の差までは見ていない(**測っていないと書いておく**)。
      */
      expect(await config("0".repeat(32), ORIGIN_A)).toBeNull();
      expect(await config(ref.siteKeyA, ORIGIN_B)).toBeNull();
    });

    it("🔴 バリアントが1つも無いポップは配らない", async () => {
      await asOwner(
        USER_A,
        `insert into public.sites (owner_id, name, allowed_origins)
           values ('${USER_A}', '空ポップ', array['${ORIGIN_A}']);
         insert into public.popups (owner_id, site_id, name, status)
           select '${USER_A}', id, '空', 'active' from public.sites where name = '空ポップ';`,
      );
      const key = await db.query<{ site_key: string }>(
        `select site_key from public.sites where name = '空ポップ'`,
      );
      expect(await config(key.rows[0].site_key, ORIGIN_A)).toBeNull();
    });
  });

  it("🕐 chatbot のバリアントは v1 では配らない(表だけ在る)", async () => {
    await db.exec(
      `update public.variants set kind = 'chatbot' where public_key = '${ref.variantKeyA2}'`,
    );
    try {
      const c = (await config(ref.siteKeyA, ORIGIN_A))!;
      expect(c.popup.variants.map((v) => v.key)).toEqual([ref.variantKeyA]);
    } finally {
      await db.exec(
        `update public.variants set kind = 'text' where public_key = '${ref.variantKeyA2}'`,
      );
    }
  });

  it("🔴 active なポップが複数あっても1つだけ返る(created_at, id の順で決定的)", async () => {
    /*
      ⚠ **要件書はこの場合を決めていない**(申し送り)。
        「決めていないことを黙って決めない」ために、**決定的な1つ**に倒してある。
        ここが測っているのは「毎回同じものが返る」ことだけで、
        **どれを返すべきかが正しい**ことは1ミリも測っていない。
    */
    await asOwner(
      USER_A,
      `insert into public.popups (owner_id, site_id, name, status)
         values ('${USER_A}', '${ref.siteIdA}', '2つ目の active', 'active');
       insert into public.variants (owner_id, popup_id, destination_url)
         select '${USER_A}', id, 'https://offer.example.com/2nd'
         from public.popups where name = '2つ目の active';`,
    );
    try {
      const first = (await config(ref.siteKeyA, ORIGIN_A))!;
      const second = (await config(ref.siteKeyA, ORIGIN_A))!;
      expect(first.popup.key).toBe(ref.popupKeyA);
      expect(second.popup.key).toBe(first.popup.key);
    } finally {
      await asOwner(USER_A, `delete from public.popups where name = '2つ目の active';`);
    }
  });
});

describe("投入: adpop_record_event", () => {
  let counter = 0;
  const nextImpression = () => {
    counter += 1;
    return `aaaaaaaa-0000-0000-0000-${String(counter).padStart(12, "0")}`;
  };
  const base = () => ({
    popupKey: ref.popupKeyA,
    variantKey: ref.variantKeyA,
    device: "mobile" as const,
    visitorHash: "0123456789abcdef0123456789abcdef",
  });

  async function storedPageUrl(impressionId: string): Promise<string | null> {
    const r = await db.query<{ page_url: string | null }>(
      `select page_url from public.events where impression_id = $1 and kind = 'impression'`,
      [impressionId],
    );
    return r.rows[0]?.page_url ?? null;
  }

  it("✅ 表示イベントが入る", async () => {
    const impressionId = nextImpression();
    const r = await record(ref.siteKeyA, ORIGIN_A, {
      ...base(),
      kind: "impression",
      triggerKind: "back",
      impressionId,
      pageUrl: `${ORIGIN_A}/lp/a`,
    });
    expect(r).toEqual({ ok: true, stored: true });
    expect(await storedPageUrl(impressionId)).toBe(`${ORIGIN_A}/lp/a`);
  });

  it("🔴 page_url は query と fragment を**削ってから**入る(要件書 §6 裁定4)", async () => {
    /*
      🔴 **CHECK に当てて落とすのではない。** 落とすと、
        `?utm_source=…` の付いた普通の LP のイベントが**まるごと消える**。
      ⚠ 0002 の CHECK は**その検算**で、両方在って初めて「削り忘れた日に気づける」。
    */
    for (const [sent, expected] of [
      [`${ORIGIN_A}/lp?email=taro%40example.com`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}/lp?utm_source=x#anchor`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}/lp#anchor?x=1`, `${ORIGIN_A}/lp`],
      [`${ORIGIN_A}?a=1`, ORIGIN_A],
      [`${ORIGIN_A}/@handle`, `${ORIGIN_A}/@handle`], // path の @ は普通の URL
    ] as const) {
      const impressionId = nextImpression();
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "back",
        impressionId,
        pageUrl: sent,
      });
      expect(r.ok, `${sent} が断られた`).toBe(true);
      expect(await storedPageUrl(impressionId), `${sent} の削り方`).toBe(expected);
    }
  });

  it("🔴 削っても形が合わない URL は断る(黙って null にして通さない)", async () => {
    for (const bad of [
      "https://taro@example.com/path", // userinfo にメールアドレスが入る形
      "lp.example.com/a", // スキームが無い
      "https://lp.example.com/a b", // 空白入り
      "javascript:alert(1)",
    ]) {
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        kind: "impression",
        triggerKind: "back",
        impressionId: nextImpression(),
        pageUrl: bad,
      });
      expect(r, `${bad} が通った`).toEqual({ ok: false, reason: "pageUrl" });
    }
  });

  it("🔴 表示と閉じるは同じ impression_id で二重に増えない(stored=false は断りではない)", async () => {
    const impressionId = nextImpression();
    const impression = { ...base(), kind: "impression", triggerKind: "back", impressionId };
    expect(await record(ref.siteKeyA, ORIGIN_A, impression)).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, impression)).toEqual({ ok: true, stored: false });

    const close = { ...base(), kind: "close", impressionId, closeReason: "esc" };
    expect(await record(ref.siteKeyA, ORIGIN_A, close)).toEqual({ ok: true, stored: true });
    expect(await record(ref.siteKeyA, ORIGIN_A, close)).toEqual({ ok: true, stored: false });

    const r = await db.query<{ c: number }>(
      `select count(*)::int as c from public.events where impression_id = $1`,
      [impressionId],
    );
    expect(r.rows[0].c).toBe(2);
  });

  it("クリックは同じ表示に何度でも入る(CTR はダッシュボードで畳む)", async () => {
    const impressionId = nextImpression();
    await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "impression", triggerKind: "back", impressionId });
    for (let i = 0; i < 2; i += 1) {
      expect(await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "click", impressionId })).toEqual({
        ok: true,
        stored: true,
      });
    }
  });

  it("✅ 発火と抑制はバリアントも表示 ID も無しで入る(まだ表示していない)", async () => {
    for (const kind of ["fire", "suppressed"]) {
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        popupKey: ref.popupKeyA,
        device: "desktop",
        kind,
        triggerKind: "exit_intent",
      });
      expect(r, kind).toEqual({ ok: true, stored: true });
    }
  });

  describe("🔴 断り(どの理由で断ったかまで固定する)", () => {
    it.each([
      ["サイトキーの形", () => record("not-a-key", ORIGIN_A, { ...base(), kind: "fire" }), "site"],
      ["実在しないサイト", () => record("0".repeat(32), ORIGIN_A, { ...base(), kind: "fire" }), "site"],
      ["許可していない Origin", () => record(ref.siteKeyA, ORIGIN_B, { ...base(), kind: "fire" }), "origin"],
      ["Origin の形", () => record(ref.siteKeyA, "lp.example.com", { ...base(), kind: "fire" }), "origin"],
      [
        "許可ドメインが空のサイト",
        () => record(ref.siteKeyEmptyOrigins, ORIGIN_A, { ...base(), kind: "fire" }),
        "origin",
      ],
      [
        "実在しないポップ",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), popupKey: "0".repeat(32), kind: "fire" }),
        "popup",
      ],
      [
        "ポップの指定が無い",
        () => record(ref.siteKeyA, ORIGIN_A, { device: "mobile", kind: "fire" }),
        "popup",
      ],
      [
        "端末が2値でない",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), device: "tablet", kind: "fire" }),
        "shape",
      ],
      [
        "知らない kind",
        () => record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "unknown" }),
        "kind",
      ],
      [
        "匿名IDの形が違う",
        () =>
          record(ref.siteKeyA, ORIGIN_A, { ...base(), visitorHash: "taro@example.com", kind: "fire" }),
        "visitorHash",
      ],
      [
        "表示 ID が uuid でない",
        () =>
          record(ref.siteKeyA, ORIGIN_A, {
            ...base(),
            kind: "impression",
            triggerKind: "back",
            impressionId: "not-a-uuid",
          }),
        "impressionId",
      ],
      [
        "表示なのにトリガ種別が無い(形の正は 0002 の CHECK)",
        () =>
          record(ref.siteKeyA, ORIGIN_A, {
            ...base(),
            kind: "impression",
            impressionId: "aaaaaaaa-9999-0000-0000-000000000001",
          }),
        "shape",
      ],
      [
        "閉じるなのに理由が無い",
        () =>
          record(ref.siteKeyA, ORIGIN_A, {
            ...base(),
            kind: "close",
            impressionId: "aaaaaaaa-9999-0000-0000-000000000002",
          }),
        "shape",
      ],
      [
        "イベントが JSON のオブジェクトでない",
        () =>
          callAsAnon<EventResult>(`select public.adpop_record_event($1, $2, $3::jsonb) as out`, [
            ref.siteKeyA,
            ORIGIN_A,
            '"文字列"',
          ]),
        "event",
      ],
    ])("%s → 断る", async (_label, run, reason) => {
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });

    it("🔴 CV(conversion)はこの口では受けない(CV 計測タグは PR6 の別の入口)", async () => {
      const r = await record(ref.siteKeyA, ORIGIN_A, { ...base(), kind: "conversion" });
      expect(r).toEqual({ ok: false, reason: "kind" });
    });
  });

  describe("🔴 他人のサイトへ書けない", () => {
    it("他サイトのポップの識別子を渡しても、そのサイトの行にならない", async () => {
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        popupKey: ref.popupKeyB, // B のポップ
        kind: "fire",
      });
      expect(r).toEqual({ ok: false, reason: "popup" });
    });

    it("他ポップのバリアントの識別子を渡しても解決しない", async () => {
      const r = await record(ref.siteKeyA, ORIGIN_A, {
        ...base(),
        variantKey: ref.variantKeyB,
        kind: "impression",
        triggerKind: "back",
        impressionId: nextImpression(),
      });
      expect(r).toEqual({ ok: false, reason: "variant" });
    });

    it("✅ 入った行は、全部そのサイトの owner のもの(所有者を呼び出し側から指定できない)", async () => {
      const r = await db.query<{ owner_id: string; site_id: string }>(
        `select distinct owner_id, site_id from public.events`,
      );
      expect(r.rows.length, "1行も入っていない = 何も測っていない").toBeGreaterThan(0);
      for (const row of r.rows) {
        expect(row.owner_id).toBe(USER_A);
        expect(row.site_id).toBe(ref.siteIdA);
      }
    });
  });
});
