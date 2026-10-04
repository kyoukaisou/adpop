/*
  配信の Worker(別オリジン)への参照の組み立て。管理画面と配信は別の Cloudflare Worker なので、
  ビルド時に埋め込む公開値(`NEXT_PUBLIC_DELIVERY_ORIGIN`。.env.example 参照)からURLを作る。
  🔴 CSPの扱い: 管理画面はまだCSPを入れていない(README「まだ入っていないもの」参照)。
    入れるときは、埋め込みタグの表示(コードブロックの文字列なので影響なし)とは別に、
    この img タグの読み込み元を `img-src` に `NEXT_PUBLIC_DELIVERY_ORIGIN` として明示的に許可する必要がある。
*/
export const DELIVERY_ORIGIN = (process.env.NEXT_PUBLIC_DELIVERY_ORIGIN ?? "").replace(/\/$/, "");

/** 画像のキー(`images/<32桁の16進>.<拡張子>`)から配信の `/img/<ファイル名>` の絶対URLを作る。配信元が未設定ならnull。 */
export function deliveryImageUrl(imageKey: string): string | null {
  if (DELIVERY_ORIGIN === "") return null;
  const filename = imageKey.startsWith("images/") ? imageKey.slice("images/".length) : imageKey;
  return `${DELIVERY_ORIGIN}/img/${filename}`;
}
