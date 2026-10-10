# PR8a: ダッシュボード全体構成(D-384)— 実物スクリーンショット

実際に動いている `wrangler dev`(ローカル D1・本物の管理 API)に対して、ログイン→画面遷移をブラウザで行って撮影した。静的モックではない。

## 画像一覧

| ファイル | 画面 | 幅 |
|---|---|---|
| `01-dashboard-1280.png` / `-390.png` | ダッシュボード(30日分のダミーイベントで実データを表示) | 1280 / 390 |
| `02-popups-1280.png` / `-390.png` | ポップ管理(新構成に移設。埋め込みタグ案内帯のみ残す) | 1280 / 390 |
| `03-tags-1280.png` / `-390.png` | タグの設置(新規画面。埋め込みタグ・許可ドメイン・CV準備中) | 1280 / 390 |
| `04-mobile-menu-open-390.png` | 390pxのハンバーガードロワー展開状態 | 390 |
| `05-site-switcher-open-1280.png` | サイト切り替えの開いた状態(発注の確認事項1。未設計のため最小実装) | 1280 |
| `06-popup-edit-1280.png` | ポップ編集(全体構成の中に統合) | 1280 |
| `07-legacy-site-redirect-landed-1280.png` | 旧 `/site?id=...` → `/popups?site=...` の転送が実際に着地した状態(Codexレビュー1巡目 指摘2) | 1280 |
| `08-sidebar-full-height-short-viewport-1280x600.png` | ビューポートより本文が長い状態でも、サイドバーの白背景がページの最後まで続く(Codexレビュー1巡目・本部のスクショ指摘) | 1280×600 |

## Codexレビュー1巡目(Blocker 5件)で直した内容

1. **期間切替の応答の逆転**: `_lib/latestWins.ts`(世代ガード)を新設し、最後に発行したリクエストの応答だけを反映。再取得中は `daily` を即座に null にし、古い期間の数字を「最新」のまま出し続けない
2. **旧 `/site?id=...` の404**: `src/app/site/page.tsx` を転送専用の互換ページとして復活(`_lib/legacySiteRedirect.ts`)。CSPテストのルート一覧にも `/site` を戻した
3. **グラフの空状態・少数値の軸の重複**: `chartHasData`(closeを数えない)・`niceTicks`(重複除去)を `_lib/dailyChart.ts` に切り出し
4. **サイドバーの離脱ガード漏れ**: 判定ロジックを `_lib/guardedLink.ts`(`resolveGuardedClick`)に1本化。`<a>` タグは全部 `GuardedLink` コンポーネント経由(パンくず・ナビ3項目・「タグの設置」カード・「すべてのサイトを管理」)、サイト切替の候補一覧(`<button>`なのでGuardedLinkにはできない)だけ同じ `resolveGuardedClick` を直接呼ぶ形にして、判定ロジック自体が2箇所に分かれないようにした
5. **テストの固定不足**: `new Date()` → `Date.now()` 経由に統一(`admin.ts`)。DailyChart・期間逆転・旧URL転送・サイドバー離脱導線のテストを追加

## 本部が実物のスクリーンショットで見つけたサイドバーの高さの不具合

`sr-only` を `<table>` に直接付けると、CSSの表レイアウトでは `width:1px;height:1px` が**最小値としてしか扱われず**、30行超の内容を持つ表は実際には240×768pxまで広がって描画されていた(`overflow:hidden`は自分の計算後の箱を基準に切り取るだけで、箱自体を縮めない)。これがページの `scrollHeight` を実際の見た目より大きくし、サイドバーの白背景が途中で止まって見えていた。`sr-only` は普通の `<div>` に付け、その中に生の `<table>` を置く形に直した(`DailyChart.tsx`)。`08-sidebar-full-height-short-viewport-1280x600.png` で直ったことを確認。

## 承認済み見本(2026-10-10-adpop-dashboard)との差分

1. **「+ ポップを作成」をダッシュボードから削除**(拓実さんの指示どおり)。見本にはあるが実装には無い。
2. **推移グラフのクリック数は右側の第2軸**(本部裁定)。表示数は左軸・実線、クリック数は右軸・破線。凡例に「(左軸)/(右軸)」を明記。
3. **埋め込みタグの配信元は `https://adpop.kyoukaisou.dev`**(確定値。見本の `workers.dev` 表記は使っていない)。
4. **サイト切り替えの開いた状態**は見本に無いため最小実装(サイト名の一覧+「+ サイトを追加」+「すべてのサイトを管理」)。`05-site-switcher-open-1280.png` 参照。
5. **「タグの設置」のサイト名・許可ドメイン編集**は見本のインライン「+ドメインを追加」ではなく、既存の `EditSiteModal`(検証ロジックを持つ)を呼ぶ「サイト名・許可ドメインを編集」リンクにした(新しい検証ロジックを増やさない選択)。

## 撮り方(再現手順)

1. ローカル D1 へ管理画面のマイグレーションを当てる: `npm run admin:migrate:local`
2. `.dev.vars` に管理者の秘密を置く(`node scripts/admin-hash.mjs` の出力を使う。コミットしない)
3. `NEXT_PUBLIC_DELIVERY_ORIGIN=https://adpop.kyoukaisou.dev npx wrangler dev -c wrangler.admin.jsonc --port 8799`
4. サイト・ポップ・30日分のダミーイベントを `src/lib/data/admin.ts` 相当の SQL で直接 INSERT(件数が無いと推移グラフが「待っています」状態にしかならないため)
5. Playwright(`playwright-core`。このリポジトリには無いので `repos/nailkarte/node_modules` から絶対パスで借りた)でログイン→各画面へ遷移→1280px/390pxでスクリーンショット

シード・撮影に使った一時スクリプトはどちらも使い捨て(scratchpad)で、このリポジトリには残していない。
