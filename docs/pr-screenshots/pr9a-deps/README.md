# PR9a 依存の版上げ — 画面が変わっていないことの確認

next 16.3.6 → 16.3.8・wrangler ^4.145.0 → ^4.149.0 への版上げが、管理画面の静的書き出し(`next build`)の出力を壊していないかを、ログイン後の主要3画面で確認した。

## 撮り方

1. `npm run admin:migrate:local`(ローカル D1 にマイグレーションを適用)
2. `node scripts/admin-hash.mjs` の出力を `.dev.vars`(コミットしない)に書く
3. ダミーのサイト・ポップ・バリアント・30日分のイベントを SQL で直接 INSERT
4. `NEXT_PUBLIC_DELIVERY_ORIGIN=https://adpop.kyoukaisou.dev npx wrangler dev -c wrangler.admin.jsonc --port 8799`
5. Playwright(`playwright-core`。このリポジトリには無いので外部に用意した Playwright 環境から借りた)でログイン→各画面へ遷移→1280px/390pxでスクリーンショット

シード・撮影に使った一時スクリプトは使い捨てで、このリポジトリには残していない。

## 画像一覧

| ファイル | 画面 | 幅 |
|---|---|---|
| `01-dashboard-1280.png` / `-390.png` | ダッシュボード | 1280 / 390 |
| `02-popups-1280.png` / `-390.png` | ポップ管理 | 1280 / 390 |
| `03-tags-1280.png` / `-390.png` | タグの設置 | 1280 / 390 |

## 判定

`docs/pr-screenshots/pr8a-dashboard/`(この版上げ前・直近の承認済みレイアウト)と見比べ、見た目の崩れ(レイアウト・フォント・配色・折り返し)が無いことを目視で確認した。
