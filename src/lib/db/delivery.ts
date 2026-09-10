/*
  配信エンドポイントが DB を呼ぶ唯一の場所。**PostgREST を経由しない。**

  ══════════════════════════════════════════════════════════════════════
  🔴🔴 **なぜ PostgREST をやめたか(2026-09-11・前の版の判断が実測で覆った)**
  ══════════════════════════════════════════════════════════════════════
  前の版はサーバーが `service_role` の鍵で `/rest/v1/rpc/...` を呼び、
  「**この鍵で届くのは関数2本だけ**」と書いていた。**その主張は測っていない範囲を含んでいた**:
    ・測っていたのは **`/rest/v1` の `public` スキーマだけ**
    ・実際には **Auth Admin API にも Storage API にも通っていた**(どちらも `/rest/v1` の外)
  🔴 実測: `POST /auth/v1/admin/users` が anon=403 / service_role=**200**。
    `DELETE` も通り、`sites.owner_id` の cascade で**サイト・ポップ・バリアントが全部消えた**。

  ✅ **いまの形**: **専用の Postgres ロール(`adpop_delivery`)で DB へ直接つなぐ。**
    ・**Auth も Storage も経路に存在しない**(この型の穴が構造ごと消える)
    ・資格が Postgres のロール1つなので、**権限を全スキーマで数え上げられる**
      → 0005 の関門 (g1)〜(g6) が毎回測る。**主張の範囲と、測る範囲が一致する。**

  🔴 **接続文字列が漏れたら何ができるか**: **この2つの関数を呼べるだけ。**
    表・連番には全スキーマで権限ゼロ / 他のロールのメンバーでない /
    SUPERUSER・CREATEROLE・CREATEDB・BYPASSRLS・REPLICATION なし。**全部を関門が測る。**
    ⚠ **残る力**: サイトキーと許可 Origin を知っていれば、**イベントを好きなだけ入れられる**
      (要件書 §4-7「イベントは誰でも偽造できる」の範囲。レート制限は PR4)。

  ⚠ **関数名を文字列で組み立てない。** 呼び出しは下の2本だけで、名前はここに直に書いてある。
*/
import postgres, { type Sql } from "postgres";

export type DeliveryResult<T> =
  /** 環境変数が無い = **こちらの設定の問題**。運用者に見せる(503) */
  | { ok: false; kind: "config"; detail: string }
  /** DB へ届かない・応答が読めない = **一時的な問題**(502) */
  | { ok: false; kind: "upstream"; detail: string }
  | { ok: true; data: T };

/** DB を待つ上限(秒)。⚠ 埋め込み先の LP を待たせないため、短く切る。 */
export const CONNECT_TIMEOUT_SECONDS = 5;
export const STATEMENT_TIMEOUT_MS = 5_000;

let cached: Sql | null = null;
let cachedUrl = "";

/**
 * 🔴 **接続はプロセスで1本に抑える**(`max: 1`)。
 *   serverless は同時に多数のインスタンスが立つので、**1インスタンスが束ねると DB の接続数が溢れる**。
 *   ⚠ 本番は Supabase の **transaction pooler** に繋ぐ前提(README)。
 *     pooler では **prepared statement を使えない**ので `prepare: false` にする。
 */
function client(url: string): Sql {
  if (cached !== null && cachedUrl === url) return cached;
  cached = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: 20,
    // ⚠ 起動時パラメータ。長いクエリで LP を待たせない
    // ⚠ 起動時パラメータは数値で渡す(`postgres` の型は number を要求する)
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS, application_name: "adpop-delivery" },
    onnotice: () => {},
  });
  cachedUrl = url;
  return cached;
}

function urlFrom(env: NodeJS.ProcessEnv): string | null {
  const url = env.ADPOP_DATABASE_URL;
  return typeof url === "string" && url.length > 0 ? url : null;
}

type Options = { env?: NodeJS.ProcessEnv };

async function run<T>(
  options: Options,
  query: (sql: Sql) => Promise<Array<{ out: T }>>,
): Promise<DeliveryResult<T>> {
  const url = urlFrom(options.env ?? process.env);
  if (url === null) {
    return {
      ok: false,
      kind: "config",
      // ⚠ 値そのものを混ぜない(ログに残る)
      detail: "ADPOP_DATABASE_URL が設定されていません",
    };
  }
  try {
    const rows = await query(client(url));
    if (rows.length !== 1) {
      return { ok: false, kind: "upstream", detail: `想定外の行数: ${rows.length}` };
    }
    return { ok: true, data: rows[0].out };
  } catch (error) {
    /*
      🔴 ここに来るのは **42501(EXECUTE が配られていない)** が代表格。
        0001 を流し直して配り直しが効かなかったときに、**静かに何も起きなくなる**経路。
        **必ず detail に残す**(握り潰して誰も見ない、を作らない)。
    */
    return { ok: false, kind: "upstream", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** サイトキー + Origin → いま有効なポップの設定。合わなければ `null`(fail-closed)。 */
export function fetchSiteConfig(
  siteKey: string,
  origin: string,
  options: Options = {},
): Promise<DeliveryResult<Record<string, unknown> | null>> {
  return run(options, (sql) =>
    sql<Array<{ out: Record<string, unknown> | null }>>`
      select public.adpop_site_config(${siteKey}, ${origin}) as out
    `.then((rows) => [...rows]),
  );
}

export type RecordOutcome = { ok: boolean; stored?: boolean; reason?: string };

/** 計測イベントを1件入れる。⚠ 形の正は 0002 の CHECK、認可は 0003/0004 の関数。 */
export function recordEvent(
  siteKey: string,
  origin: string,
  event: Record<string, unknown>,
  options: Options = {},
): Promise<DeliveryResult<RecordOutcome>> {
  return run(options, (sql) =>
    sql<Array<{ out: RecordOutcome }>>`
      select public.adpop_record_event(${siteKey}, ${origin}, ${sql.json(event as never)}) as out
    `.then((rows) => [...rows]),
  );
}

/** ⚠ テスト用。プロセス内のキャッシュを捨てる(接続文字列を差し替えたいとき)。 */
export function resetDeliveryClient(): void {
  cached = null;
  cachedUrl = "";
}
