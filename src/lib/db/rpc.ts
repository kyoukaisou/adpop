/*
  Supabase の Data API(PostgREST)へ **anon の鍵で** RPC を1本投げるだけのモジュール。

  🔴 **`service_role` の鍵を使わない。** 認可は DB(0003 の `security definer` 関数)に委ねる。
    ⚠ `.env.example` にも service_role の欄を作っていない —— **バイパスの置き場を作らない**。
  🔴 **クライアントライブラリを入れない。**
    ・要件書 §7 の実装制約「Supabase 固有の機能に食い込みすぎない(後で剥がせる程度に)」
    ・依存を1つ増やすと、剥がすときに剥がす対象が増える
    → `fetch` で `/rest/v1/rpc/<関数名>` を叩くだけ。**自前ホスト(§7 の (b))へ移すときは
      この1ファイルの中だけを書き換える。**

  🔴 **失敗を握り潰さない。** 呼び出し側が「設定が無い」「上流が落ちた」「断られた」を
    **区別できる形**で返す。⚠ 全部 null にすると、**設定を書き忘れた日と
    許可ドメインを外した日が、同じ「ポップが出ない」に見える。**
*/

/** 呼んでよい RPC。⚠ 名前を呼び出し側から文字列で渡させない(URL に混ざる)。 */
export const RPC = {
  siteConfig: "adpop_site_config",
  recordEvent: "adpop_record_event",
} as const;

export type RpcName = (typeof RPC)[keyof typeof RPC];

export type RpcResult<T> =
  | { ok: true; data: T }
  /** 環境変数が無い = **こちらの設定の問題**。運用者に見せる(503) */
  | { ok: false; kind: "config"; detail: string }
  /** 上流が落ちた・応答が読めない = **一時的な問題**(502) */
  | { ok: false; kind: "upstream"; detail: string };

/** 上流を待つ上限。⚠ 埋め込み先の LP を待たせないため、短く切る。 */
export const RPC_TIMEOUT_MS = 5_000;

type Env = { url?: string; key?: string };

function readEnv(env: NodeJS.ProcessEnv): Env {
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

export async function callRpc<T>(
  name: RpcName,
  args: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RpcResult<T>> {
  const { url, key } = readEnv(options.env ?? process.env);
  if (!url || !key) {
    return {
      ok: false,
      kind: "config",
      // ⚠ 値そのものを混ぜない(ログに残る)
      detail: `NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が設定されていません`,
    };
  }
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(options.timeoutMs ?? RPC_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, kind: "upstream", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    /*
      🔴 ここに来るのは **42501(権限が配られていない)** が代表格。
        0001 を流し直して ⑥ の配り直しが効かなかったときに、**静かに何も起きなくなる**
        経路がここ。**必ず detail に残す。**
    */
    const body = await response.text().catch(() => "");
    return { ok: false, kind: "upstream", detail: `HTTP ${response.status} ${body.slice(0, 300)}` };
  }
  try {
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return { ok: false, kind: "upstream", detail: error instanceof Error ? error.message : String(error) };
  }
}
