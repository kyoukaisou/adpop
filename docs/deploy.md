# Cloudflare に立てる(本番の手順)

> 対象: このリポジトリを初めて Cloudflare(Workers + D1 + R2)に立てるとき。
> 背景: 本番前の点検(2026-10-05)で、立てる手順が無いことと、立てる前に決めるべきことが指摘された。
> この文書が参照する README の節は [README.md](../README.md) を見てください。
>
> 🔴 **机上で閉じない。** この手順は、クリーンな `git worktree` から
> `npm ci` → `npm run build` → 両 Worker の `wrangler deploy --dry-run` → `wrangler d1 migrations apply --local`
> を実際に1回走らせてから書いています(2026-10-05)。**Cloudflare 側に実リソースを作る手順(§2・§3・§4・§5・§6・§7)は
> 確かめていません**(作業範囲として、Cloudflare のリソースを作る・消す・deploy するコマンドを実行しない
> という制約のため)。手順の各段に「確かめ方」を書いたので、**最初の実施者がそこで確認してから次へ進んでください**。
>
> 🔴 **配信・管理画面は、workers.dev ではなく独自ドメインの Custom Domain で受ける**(§5)。
> `wrangler deploy --dry-run`(両 Worker)は、この Custom Domain 構成のままローカルで実際に通ることを
> 確かめている(2026-10-07。認証情報は不要 —— dry-run は Cloudflare に接続しない)。**Custom Domain を
> 実際に Cloudflare 上へ作る操作そのもの(DNS・証明書の発行を含む)はこの PR では行っていない。**

## 0. 前提

- Node.js 24
- Cloudflare アカウント1つ(二要素認証を有効にしておく。README「Cloudflare のアカウントを守ってください」)
- デプロイに使う API トークンは **D1・R2・Workers に絞る**(`wrangler login` の全権トークンを使わない)
- 🔴 **この手順のうち、パスワード・secret の生成と投入(§7)は、運用者の端末で人が行ってください。**
  `npm run admin:hash` を人の手を介さない場所(AI エージェントの実行環境など)で実行すると、
  平文のパスワードがその場所の記録(会話ログ等)に残ります。

## 1. クリーンな checkout

```bash
git clone https://github.com/kyoukaisou/adpop.git
cd adpop
git status   # 何も出ないこと(追跡外ファイルが混ざった作業ツリーから build しない)
npm ci
```

- **確かめ方**: `npm ci`(`npm install` ではない)で `package-lock.json` どおりに入ったことを確認する。
  2026-10-05 実測ではこの手順で `node 24.10.0` / `619 packages` が通った。`npm audit` の結果は
  本番前の点検で別途確認済み(本番(`--omit=dev`)の依存は Critical・High ともに0件)。

## 2. D1 を作る

> 🔴 **本番の D1 は作成済みです**(`wrangler d1 create adpop`。D-344・2026-10-05)。
> その出力の `database_id`(`2d56e040-2e9a-4cb2-b431-2829cb488a96`)は、すでに両方の
> 設定ファイルに入っています(`wrangler.delivery.jsonc` / `wrangler.admin.jsonc` の
> `d1_databases[0].database_id`)。本番にこれから立てる人は、この節を読み飛ばして
> § 3 に進んでください。
>
> 以下は、**別の環境(自分の Cloudflare アカウントなど)に初めて立てる人**のための手順です。

```bash
npx wrangler d1 create adpop
```

- 出力の `database_id` を**両方**の設定ファイルに差し替える:
  - `wrangler.delivery.jsonc` の `d1_databases[0].database_id`
  - `wrangler.admin.jsonc` の `d1_databases[0].database_id`
- 🔴 **2つの id は、両 `wrangler.*.jsonc` の `build.command`(`node scripts/check-database-ids-match.mjs`)が
  機械で一致を見ます。** 片方だけ差し替え忘れると、deploy がそこで落ちます(「目で見比べる」手順はもう
  要りません)。
- 🔴 **`tests/admin-config.test.ts` の「現在のリポジトリの状態」テストは、本部が確認した本番(D-344)の
  id(`2d56e040-2e9a-4cb2-b431-2829cb488a96`)と完全一致するかを固定しています。** 自分の環境に別の D1 を
  立てる場合は、そのテストの `PRODUCTION_DATABASE_ID` の期待値も自分の id に書き換えてください
  (書き換えないと、設定ファイルは正しくても、このテストだけ落ちます)。
- 🔴 **仮の値(`00000000-0000-4000-8000-000000000000`)のままだと、両方が一致していても deploy は
  止まります。** `scripts/database-id-guard.mjs` の `isPlaceholderDatabaseId()` が既知の仮の値を
  明示的に拒否します(前巡の検査は「非空かつ一致」しか見ておらず、両方とも仮の値のまま揃っている
  状態を合格にしてしまっていました)。**実際に `wrangler d1 create adpop` を実行して得た id に
  両方差し替えるまで、deploy は進みません。**
- Time Travel は常時有効です。移行の前に時点を控えておくと、戻すときの目印になります:
  ```bash
  npx wrangler d1 time-travel info adpop -c wrangler.delivery.jsonc
  ```

## 3. R2 バケットを作る

```bash
npx wrangler r2 bucket create adpop-images
```

- 🔴 **公開設定(Public Development URL・独自ドメインの接続)には触らない。** `r2.dev` もカスタムドメインも
  付けません。画像は配信の Worker の `/img/<キー>` が R2 のバインドから返すので、バケット自体を公開する
  理由がありません(R2 は既定で非公開。有効化は Cloudflare ダッシュボードで明示的にしたときだけ発生します)。
- `wrangler.*.jsonc` の `r2_buckets` はバインド名(`IMAGES`)とバケット名(`adpop-images`)だけで、
  公開設定は持っていません(設定ファイルを直しても公開にはなりません)。

## 4. マイグレーションを当てる(deploy の前)

```bash
npx wrangler d1 migrations apply adpop --remote -c wrangler.delivery.jsonc
npx wrangler d1 migrations apply adpop --remote -c wrangler.admin.jsonc
```

- 🔴 **`--remote` を必ず付ける。** `wrangler d1 migrations apply --local`(明示)は手元の複写にだけ当たります。
  **`--local` も `--remote` も付けなかったときどちらに当たるかは、Wrangler の公式ヘルプ・公式文書のどちらにも
  明記が見つからず確かめられませんでした(未確認)。** 2026-10-05 時点の `wrangler d1 migrations apply --help`
  には「Execute commands/files against a local DB」「Execute commands/files against a remote DB」とだけ
  書かれ、どちらが既定かの記述はありません。Wrangler v4 の KV・R2 コマンドは「既定でローカル」に変わった
  (公式の v3→v4 移行ガイド)ことから D1 も同様の可能性がありますが、**D1 固有の記述では確認できていません**。
  **どちらであっても明示すれば事故にならない**ので、このコマンドには常に `--remote` を書いてください。
- 両方の設定ファイル(配信・管理画面)に対して実行する(どちらも同じ D1 を見ますが、`migrations_dir` の
  適用履歴はそれぞれの `-c` ごとに記録が作られる可能性があるため、両方で確認する)。
- **確かめ方**(2026-10-05 実測・`--local` で代用): `wrangler d1 migrations apply adpop --local -c wrangler.delivery.jsonc`
  は `0001_schema.sql`→`0002_admin_auth.sql`→`0003_event_stats_index.sql` の順に当たり、`--local` を
  `wrangler.admin.jsonc` にも実行すると「No migrations to apply」(同じ永続化ディレクトリを共有するローカルの
  挙動)。**本番(`--remote`)は、両方の設定ファイルに対して実行してから、同じ内容で2回目を流して
  「No migrations to apply」になることを確認してください。**
- 失敗したときは、そのファイルだけが戻ります(ローカルで実測: 途中で落ちる移行を書いて当てると、作った表も
  入れた行も残らず `d1_migrations` にも載らない)。本番でこの挙動が同じかは確認していません。

### PRAGMA optimize(ANALYZE)— 統計は自動更新されない

- **D1 は `ANALYZE` の結果(`sqlite_stat1`)を自動更新しません。** Cloudflare の公式文書は
  「We recommend running this command after making any changes to the schema (for example, after creating
  an index)」と明記しており、`PRAGMA optimize`(内部で `ANALYZE` を呼ぶ)は**運用者が手動で実行するもの**として
  案内されています([D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/))。
  マイグレーションの適用だけでは統計は更新されません。
- マイグレーションを当てたら、このコマンドを実行する:
  ```bash
  npx wrangler d1 execute adpop --remote -c wrangler.delivery.jsonc --command "PRAGMA optimize;"
  ```
- 📌 これを怠ると、索引を追加しても SQLite のクエリプランナが古い索引を選び続けることがある
  (開発中に実測済み。`ANALYZE` を1回実行した後は狙った索引が選ばれた)。

## 5. 配信・管理画面とも独自ドメインの Custom Domain で受ける(`workers.dev` は使わない)

**配信ホストは独自ドメインの Custom Domain を使います。`workers.dev` は使いません。** 埋め込みタグの
`src`(配信ホスト)は、**配ったタグの数だけ第三者の LP に任意の JS を配れる場所**で、タグは他人の LP に
貼られるとこちらから回収できないため、ホスト名は確定事項として扱ってください。

- 配信ホスト: `https://adpop.kyoukaisou.dev`(`deploy/delivery-origin.txt` に確定値を1か所だけ置いてある)
- 管理画面ホスト: `https://adpop-admin.kyoukaisou.dev`(`scripts/custom-domain-guard.mjs` の
  `ADMIN_CUSTOM_DOMAIN_HOST` に確定値を置いてある)
- 両方とも `wrangler.*.jsonc` の `routes` に、`custom_domain: true` を付けたホスト名1件だけを持つ。
  **zone の routes(パターンで受ける方式)は使わない。** 同じホスト名に一致する zone の route は
  Custom Domain の Worker より前に走る(Cloudflare 公式文書「Custom Domains」)ため、広い pattern を
  持つ別の Worker を1つ増やすだけで配信・管理画面の通信を横取りできる経路になる。このゾーンに他の
  Worker の `routes` を足さないこと(自分の環境に立てる場合も同じ)。
- 🔴 **`workers_dev` も両方 `false`。** ダッシュボードで切るだけでは次の deploy で復活する
  (Cloudflare 公式文書「workers.dev」)ため、設定ファイルに書いて持つ。
- 🔴 **deploy 前の検査(§6)に、この3点(workers_dev・zone の route が無いこと・custom domain の
  ホストが確定値と一致すること)を見逃す経路は無い。** `scripts/check-custom-domain.mjs` が両
  `build.command` から必ず走る。配信元が `deploy/delivery-origin.txt` の確定値と完全一致しているかの
  検査(`scripts/delivery-origin-guard.mjs`)も、旧構成のときから変わらず走る。

### Cloudflare 上で初めて立てる手順

1. この Cloudflare アカウントで、独自ドメイン(自分の環境に立てる場合は自分が持つドメインに読み替える)
   の DNS をこのアカウントへ向ける(Cloudflare Registrar で取得するか、既存ドメインのネームサーバを
   Cloudflare に向ける)。
2. §6 の手順で両 Worker を deploy する。`routes` に書いた Custom Domain のホスト名ごとに、
   Cloudflare が Advanced Certificate を自動で発行する(Cloudflare 公式文書「Custom Domains」)。
3. 🔴 **証明書の発行が終わり、実際に HTTPS で 200 が返ることを確かめてから**、埋め込みタグを配布する・
   管理画面へのログインを人に伝える。証明書の発行には時間がかかることがあり、終わるまで HTTPS は
   失敗する(このドメインが HSTS preload 対象の TLD であれば、HTTP への後退もできない)。
4. 🔴 **DNSSEC を有効にする(ダッシュボード)。最初のタグを配る前に。** Cloudflare Registrar の
   ドメインなら DS レコードは自動で作られる(反映は1〜2日)。DNS のキャッシュ汚染で配信先を
   差し替えられる経路を閉じるため。
5. **それ以後、`deploy/delivery-origin.txt` の値・`routes` のホスト名・配信 Worker の名前
   (`adpop-delivery`)は変えない。** 変えると、既に配ったタグが全部壊れる(タグは第三者の LP に
   貼られていて回収できない)。

⚠ このリポジトリを fork して自分の環境に立てる場合は、`wrangler.delivery.jsonc` /
`wrangler.admin.jsonc` の `routes[0].pattern`、`deploy/delivery-origin.txt`、
`scripts/custom-domain-guard.mjs` の `ADMIN_CUSTOM_DOMAIN_HOST` を、自分が持つドメインのホスト名に
書き換えてください。README「管理画面は LP と別の登録ドメインに置いてください」も、別のサブドメインを
選ぶことで満たせます。

## 6. デプロイする

### 配信の Worker

```bash
npx wrangler deploy -c wrangler.delivery.jsonc
```

- 🔴 `wrangler.delivery.jsonc` は `build.command` に
  `npm run build:embed && npm run check:bundle-size && npm run check:embed-independence && node scripts/check-database-ids-match.mjs && node scripts/check-custom-domain.mjs`
  を設定してあります。**`wrangler deploy` を実行するだけで、埋め込みの束ね直し・サイズ上限・ライセンス境界・
  database_id の一致・Custom Domain の構成(§5)がすべて deploy の前に走ります。** 埋め込みソースを直した後に
  `wrangler deploy` だけ実行しても、古い `dist/delivery-assets` が上がることはありません(毎回束ね直すため)。

### 管理画面の Worker

```bash
NEXT_PUBLIC_DELIVERY_ORIGIN=$(cat deploy/delivery-origin.txt) npx wrangler deploy -c wrangler.admin.jsonc
```

- 🔴 `wrangler.admin.jsonc` は `build.command` に
  `npm run build && node scripts/check-admin-headers.mjs && node scripts/check-database-ids-match.mjs && node scripts/check-custom-domain.mjs`
  を設定してあります。**`wrangler deploy` を実行するだけで、埋め込み束ね → `next build` → `out/_headers`
  の CSP 組み立て → ①CSP に `unsafe-inline`/`unsafe-eval` が無い ②`NEXT_PUBLIC_DELIVERY_ORIGIN` が
  `deploy/delivery-origin.txt` の確定値と**完全一致**している ③その値が CSP の `img-src` とビルド出力
  (`out/_next` の JS)の両方に実際に埋め込まれている ④`X-Content-Type-Options`/`X-Frame-Options`/
  `Referrer-Policy` が揃っている ⑤両 `wrangler.*.jsonc` の database_id が一致していて、かつ仮の値ではない
  ⑥両 Worker とも `workers_dev: false`・zone の routes が無く・Custom Domain のホストが確定値と一致している、
  の6点が deploy の前に自動で検査されます**。`NEXT_PUBLIC_DELIVERY_ORIGIN` は**このコマンドを呼ぶシェルの
  環境変数として**渡してください(`build.command` は呼び出し元の環境変数を引き継ぎます)。
- ⚠ `build.command` は `wrangler dev`(ローカル開発)でも走ります(Wrangler の仕様。deploy 専用ではありません)。
  開発中に重いと感じたら、README の「動かし方(開発)」どおり `npm run build` を手で1回だけ走らせてから
  `admin:dev` を使う運用でも構いません(`build.command` はその場合も毎回走り直すので、ビルドが速いなら
  気にしなくて良い程度の差です)。
- 🔴 **この6点の検査には、省略する経路が1つも無い。** 本番の `wrangler deploy` に何を渡しても
  (フラグ・環境変数いずれも)この検査を素通りさせることはできません。
- ⚠ **CI の dry-run は値を書き換えない。** 配信元(`deploy/delivery-origin.txt`)・database_id ともに
  実在の確定値がすでにコミットされているため、CI はそのままの値で dry-run する(`.github/workflows/ci.yml`)。
  dry-run は Cloudflare に接続しないので、CI が Cloudflare の認証情報を持たないことと矛盾しない。
  (旧構成では配信元が `UNSET` のままで CI 専用の仮の値に一時的に書き換えていたが、配信元を独自ドメインに
  確定させたこの PR 以降は、その書き換え自体が要らなくなった。)
- 2026-10-05 実測(旧構成から変わらず有効):
  - `node scripts/check-admin-headers.mjs` を単独で実行し、`out/_headers` を一時的にリネームして退避させると
    `NG  …/out/_headers が無い` で非ゼロ終了し、戻すと `OK` に戻ることを確認した。
  - `wrangler.admin.jsonc` の `database_id` だけを別の値に差し替えて `wrangler deploy -c wrangler.delivery.jsonc --dry-run`
    を実行すると、`check-database-ids-match.mjs` が不一致を検出して deploy が止まることを確認した
    (どちらの Worker を先に deploy しても検査が効く)。
- 2026-10-07 実測(Custom Domain への切り替え時):
  - 現在のコミット済みの設定(`deploy/delivery-origin.txt` が `https://adpop.kyoukaisou.dev`・両
    `wrangler.*.jsonc` が `workers_dev: false` + `routes: [{ pattern: …, custom_domain: true }]`)のまま、
    `wrangler deploy --dry-run -c wrangler.delivery.jsonc` と
    `NEXT_PUBLIC_DELIVERY_ORIGIN=$(cat deploy/delivery-origin.txt) wrangler deploy --dry-run -c wrangler.admin.jsonc`
    の両方が、Cloudflare の認証情報無しで成功することを確認した(`--dry-run` は Cloudflare に接続しない)。
  - `wrangler.delivery.jsonc` の `workers_dev` だけを一時的に `true` に書き換えると
    `node scripts/check-custom-domain.mjs` が `NG  配信: workers_dev が false になっていない` で
    非ゼロ終了し、元に戻すと `OK` に戻ることを確認した。
  - `scripts/custom-domain-guard.mjs` の `customDomainRouteProblems()` 単体に、zone の route(`custom_domain`
    無し)・確定値と違うホスト名・確定ホストに加えて別の route が増えている場合をそれぞれ渡し、
    いずれも問題として検出されることを確認した(`tests/admin-config.test.ts` にも固定済み)。

## 7. secret を投入する(運用者の端末で)

🔴 **この節は、運用者が自分の端末のターミナルで直接実行してください(AI エージェントに代行させない)。**
`npm run admin:hash` は平文のパスワードを1回だけ標準出力に表示する設計です。

```bash
npm run admin:hash
#   表示されたパスワードはパスワード管理ツールへ保存する(この画面以外には出ません)
npx wrangler secret put ADMIN_PASSWORD_HASH -c wrangler.admin.jsonc    # ← 表示された値を貼る
npx wrangler secret put ADMIN_RATE_LIMIT_KEY -c wrangler.admin.jsonc   # ← 表示された値を貼る
npx wrangler secret put ADMIN_OWNER_ID -c wrangler.admin.jsonc        # ← 表示された値を貼る(最初の1回だけ)
npx wrangler secret put ADMIN_EMAIL -c wrangler.admin.jsonc           # ← ログインに使うメールアドレス
```

- 🔴 **この手順は §6 で管理画面の Worker を deploy した後に行います。** `wrangler secret put` は
  対象の Worker 名(`-c` の設定が指す `name`)がまだ Cloudflare 上に存在しないと、確認プロンプトの後に
  **空の draft Worker をその名前で新規作成してから** secret を書き込む、という報告が複数の
  サードパーティ(Cloudflare 利用者の issue 報告)にあります。**Cloudflare 公式文書にはこの挙動の
  明記が見つからず、この PR の作業では Cloudflare 上で実際に試していません(未確認)。** §6 を先に行えば、
  このコマンドを打つ時点で Worker は既に存在しているので、この中間状態(空の draft Worker)を踏む
  心配そのものを避けられます。
- §6 で deploy した直後(secret 投入前)の管理 API は、secret が無いため 503 を返します
  (`src/admin/app.ts` が secret 欠けを検出して返す値。fail-closed)。認証が開いたまま secret 無しで
  動く順序にはなっていません。
- ローカル開発用の `.dev.vars` は本番の secret と**別に**生成してください(同じ値を使い回さない)。

## 8. 動作確認(外形)

- 本番で1回ログインする(README の既存の注意: 本番の PBKDF2 反復上限はローカルの wrangler では再現できません)
- 未認証で `GET /api/admin/sites` を叩き、401 が返ること
- 画面(`/sites` など)の応答ヘッダに `Content-Security-Policy` があること
- R2 の公開(Public Development URL・カスタムドメイン)が有効になっていないこと(ダッシュボードで確認)
- `npx wrangler secret list -c wrangler.admin.jsonc` に4つの名前(`ADMIN_PASSWORD_HASH` /
  `ADMIN_RATE_LIMIT_KEY` / `ADMIN_OWNER_ID` / `ADMIN_EMAIL`)が出ること
- `preview_urls: false` / `workers_dev: false` / `routes` が Custom Domain のホスト1件だけであること
  (両 `wrangler.*.jsonc` の既定どおり。Version URL を無効化し、独自ドメインだけで出す)

## preview_urls・workers.dev・routes の扱い

- **両 Worker とも `preview_urls: false` を明示しています。** 修正前の版(Version URL)を本番の secret・D1 の
  まま動かし続けさせないため。この手順でも変更しません。
- **`workers_dev: false`・`routes` は Custom Domain のホスト1件だけです。** §5 の決定どおり、本番は
  `https://adpop.kyoukaisou.dev`(配信)/ `https://adpop-admin.kyoukaisou.dev`(管理画面)だけで出ます。
  どちらも別の登録ドメインではなく同じ `kyoukaisou.dev` のサブドメインです。`SameSite=Strict` は
  兄弟サブドメインには効きませんが、Origin の完全一致・`Sec-Fetch-Site`・`__Host-` 接頭辞の Cookie
  (下の2点)で CSRF・セッションの固定を塞いでいるため、管理画面を LP と別ドメインに置く要件
  (README)はこの構成でも満たしています。
- 🔴 **このゾーンに zone の routes を足さないこと。** 広い pattern を持つ Worker を1つ増やすだけで、
  Custom Domain の Worker より前に走り、配信・管理画面の通信を横取りできる経路になります
  (Cloudflare 公式文書「Custom Domains」)。Worker を増やすときは、必ず別の Custom Domain
  (別のホスト名)にしてください。
- 🔴 **Cookie に `Domain` 属性を付けないこと。** `Domain=kyoukaisou.dev` の Cookie は同じゾーンの
  全サブドメインに送られます。管理画面のセッション Cookie は `__Host-` 接頭辞(`Domain` を付けられない)
  にしてください(現在の実装はこの形。`src/admin/cookie.ts`)。

## D1 の1日の書き込み上限について(受け入れて出す)

- **Workers Free の D1 は、1日 100,000 行の書き込み / 500 万行の読み取りが上限です**(一次:
  [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)。「When your account hits the daily
  read and/or write limits, you will not be able to run queries against D1」)。
- イベント1件の投入(`fire`)は表1行 + 索引4本で**約5行**の書き込みになる見込みです(索引の数え方からの
  **推定**。本番で計測していません)。この数え方を当てはめると、**偽造イベント約2万件**で無料の書き込み枠が
  尽きる見込みです。これは Workers の「1日 10 万リクエスト」の上限より**先に**尽きます。
- 尽きると、**アカウントの D1 全体に問い合わせできなくなります。** 配信は fail-closed(LP 自体は壊れず、
  ポップが出ないだけ)。管理画面は**ログインもセッション確認もできなくなります**。UTC 0 時まで戻りません。
- **この PR での判断(README にも明記)**: 最初の本番(自分の LP だけに配る間)は、この限界を受け入れて出します。
  **他人の LP にタグを配る前に、イベント投入へのレート制限を入れてください**(現状は入っていません)。
  受け入れる理由: 失敗の向きが fail-closed(LP 自体は壊れない)で、収益化前に課金(Workers Paid への切り替え)
  を増やさずに済むため。⚠ 正規の流量だけでも、表示1回 ≈ 15 行(fire + impression + close/click)の見込みで
  **1日 約 6,000 表示**(推定)で枠に届くので、使う人数が増えたら Workers Paid への切り替えを再検討してください。

## まだ実行していないこと(Cloudflare の上の作業)

この PR の作業はすべて `--dry-run` / `--local` に限っています。本番の D1 の作成と `database_id` の
両設定ファイルへの反映(§2)、配信・管理画面のホスト名を独自ドメインの Custom Domain に確定させること
(§5)は、過去の PR とこの PR で済んでいます。次の実施者が実際に Cloudflare 上で行うのは:

- 独自ドメインの DNS をこの Cloudflare アカウントへ向ける(§5 手順1。まだ向けていなければ)
- `wrangler r2 bucket create adpop-images`(§3)
- `wrangler d1 migrations apply --remote`(§4。本番 D1 への実際の適用)
- `wrangler d1 execute --remote --command "PRAGMA optimize;"`(§4)
- `wrangler deploy`(§6。配信・管理画面の両 Worker)。ここで初めて Custom Domain の証明書が
  発行される(§5 手順2・3)
- DNSSEC の有効化(§5 手順4)
- `npm run admin:hash` と4つの `wrangler secret put`(§7。運用者の端末で)
- §8 の外形確認
