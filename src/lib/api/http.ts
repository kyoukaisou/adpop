/*
  配信エンドポイントの入口で使う、**判定だけを持つ関数**(副作用なし・Next.js に依存しない)。
  ⚠ ここに書くのは「要求の形」だけ。**認可(サイトキー × Origin × 許可ドメイン)は DB の関数が持つ**
    —— 同じ規則を2か所に書くと、片方だけ直した日に静かにずれる。

  🔴 **形の検査をここに写さない**という判断について:
    サイトキーが `^[0-9a-f]{32}$` か、Origin が Origin の形か、は
    **0003 の `adpop_site_config` / `adpop_record_event` が見ている**(そちらが正)。
    ここで見るのは **長さの上限**だけ —— 「巨大な文字列を DB まで運ばない」ための入口の防御で、
    **判定ではない**。⚠ したがってここを通っても「正しい」ことは1ミリも意味しない。
*/

/** サイトキーの文字数の上限。実物は32桁だが、**形の判定は DB がする**ので余裕を持たせる。 */
export const MAX_SITE_KEY_LENGTH = 64;

/** Origin ヘッダの文字数の上限(RFC 上のホスト名の上限 253 + スキームとポート)。 */
export const MAX_ORIGIN_LENGTH = 300;

/**
 * イベント1件の本文の上限。
 * 🔴 **実測に基づく数字ではなく、本部が置いた設計値**。
 *   いちばん大きい `impression` でも、鍵5本 + URL(最大2048)+ 定型で 2.5KB 程度。
 *   ⚠ ここを上げるときは `page_url` の上限(0002 の CHECK = 2048)と一緒に考える。
 */
export const MAX_EVENT_BODY_BYTES = 4 * 1024;

export type RequestProblem = { status: number; reason: string };

/**
 * `Origin` ヘッダを取り出す。
 * 🔴 **無ければ拒否する(fail-closed)。** 埋め込みスクリプトはクロスオリジンで呼ぶので、
 *   ブラウザは必ず `Origin` を付ける。**付いていない要求はブラウザ以外**からのもの。
 * ⚠ **`Referer` へは落とさない**(要件書 §5-3 は「主判定は Origin・Referer は補助」だが、
 *   補助の側を v1 では使わない —— **緩める方向の分岐を、要らないうちに作らない**)。
 * ⚠ **偽造は防げない**(要件書 §4-7)。ここが守るのは「他人の LP に貼られた場合」だけで、
 *   `curl` に対しては何も守らない。
 */
export function originProblem(origin: string | null): RequestProblem | null {
  if (origin === null || origin.length === 0) return { status: 403, reason: "origin" };
  if (origin.length > MAX_ORIGIN_LENGTH) return { status: 403, reason: "origin" };
  return null;
}

export function siteKeyProblem(siteKey: string | null): RequestProblem | null {
  if (siteKey === null || siteKey.length === 0) return { status: 400, reason: "site_key" };
  if (siteKey.length > MAX_SITE_KEY_LENGTH) return { status: 400, reason: "site_key" };
  return null;
}

/**
 * 本文を**上限まで**読む。上限を超えたら**そこで読むのをやめて**断る。
 * 🔴 `await request.text()` だと、**上限を判定する前に全部メモリへ載る**。
 *   ⚠ `Content-Length` だけを見るのも駄目(chunked では付かない・偽れる)。
 *   → **数えながら読み、超えた時点で打ち切る。**
 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_EVENT_BODY_BYTES,
): Promise<{ text: string } | { problem: RequestProblem }> {
  if (body === null) return { problem: { status: 400, reason: "body" } };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        // 413 = Payload Too Large。⚠ 読み残しは捨てる(相手に付き合わない)
        await reader.cancel().catch(() => {});
        return { problem: { status: 413, reason: "body_too_large" } };
      }
      chunks.push(value);
    }
  } catch {
    return { problem: { status: 400, reason: "body" } };
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged) };
}

/**
 * 本文を JSON のオブジェクトとして読む。
 * ⚠ **`Content-Type` は見ない。** 埋め込みスクリプトは preflight を起こさないために
 *   `text/plain;charset=UTF-8` で送る(= 単純リクエスト)。中身が JSON かどうかだけを見る。
 */
export function parseJsonObject(text: string): { value: Record<string, unknown> } | { problem: RequestProblem } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: { status: 400, reason: "json" } };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problem: { status: 400, reason: "json" } };
  }
  return { value: parsed as Record<string, unknown> };
}

/**
 * 許可された Origin にだけ付ける CORS のヘッダ。
 * 🔴 **`*` を返さない。** 呼んできた Origin をそのまま返し、`Vary: Origin` を必ず付ける
 *   (付けないと、CDN や中間のキャッシュが**別の Origin の応答**を配りうる)。
 * 🔴 **断るときは1つも付けない** —— ヘッダが付いた時点で「許可した」と言っていることになる。
 */
export function corsHeaders(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

/**
 * 🔴 **キャッシュしない**(v1)。
 *   要件書 §4-1 は「CDN キャッシュを効かせる」と書いているが、この応答は
 *   **サイトキー × Origin の認可の結果**なので、**許可ドメインを外した瞬間に
 *   古い設定が配られ続ける経路**が同時に生まれる。
 *   → **無効化の手順を決める PR まで、キャッシュは入れない**(README に「入れていない」と書く)。
 */
export const NO_STORE = "no-store";
