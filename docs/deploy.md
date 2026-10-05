# Cloudflare に立てる(本番の手順)

> 対象: `repos/adpop` を初めて Cloudflare(Workers + D1 + R2)に立てるとき。
> 背景: 本番前の総点検(2026-10-05)で、立てる手順が無いことと、立てる前に決めるべきことが指摘された。
> この文書が参照する README の節は [README.md](../README.md) を見てください。
>
> 🔴 **机上で閉じない。** この手順は、作業ツリー `repos/adpop-deploy`(クリーンな `git worktree`)から
> `npm ci` → `npm run build` → 両 Worker の `wrangler deploy --dry-run` → `wrangler d1 migrations apply --local`
> を実際に1回走らせてから書いています(2026-10-05)。**Cloudflare 側に実リソースを作る手順(①②④⑦⑧)は
> 確かめていません**(この PR の作業範囲では Cloudflare のリソースを作る・消す・deploy するコマンドを実行しない
> という制約のため)。手順の各段に「確かめ方」を書いたので、**最初の実施者がそこで確認してから次へ進んでください**。

## 0. 前提

- Node.js 24
- Cloudflare アカウント1つ(二要素認証を有効にしておく。README「Cloudflare のアカウントを守ってください」)
- デプロイに使う API トークンは **D1・R2・Workers に絞る**(`wrangler login` の全権トークンを使わない)
- 🔴 **この手順のうち、パスワード・secret の生成と投入(§6)は、運用者の端末で人が行ってください。**
  AI 社員が `npm run admin:hash` を実行すると、平文のパスワードが会話ログに残ります(本監査 P2)。

## 1. クリーンな checkout

```bash
git clone https://github.com/kyoukaisou/adpop.git
cd adpop
git status   # 何も出ないこと(追跡外ファイルが混ざった作業ツリーから build しない)
npm ci
```

- **確かめ方**: `npm ci`(`npm install` ではない)で `package-lock.json` どおりに入ったことを確認する。
  2026-10-05 実測ではこの手順で `node 24.10.0` / `619 packages` が通った(High 6件は devDependencies の
  lint 用パッケージのみ。§5 の npm audit を見る)。

## 2. D1 を作る

```bash
npx wrangler d1 create adpop
```

- 出力の `database_id` を**両方**の設定ファイルに差し替える:
  - `wrangler.delivery.jsonc` の `d1_databases[0].database_id`
  - `wrangler.admin.jsonc` の `d1_databases[0].database_id`
- 🔴 **2つの id を必ず同じ値にする。** `tests/admin-config.test.ts` は database の**名前**(`adpop`)の一致しか
  見ていません(本監査 L9)。id が割れていても検査は落ちないので、貼り替えたら目で見比べてください。
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

## 5. デプロイより前に、配信ドメインを決める(戻しにくい・P3)

- 埋め込みタグの `src`(配信ホスト)は、**配ったタグの数だけ第三者の LP に任意の JS を配れる場所**です。
  タグは他人の LP に貼られるとこちらから回収できないので、**最初のタグを1本でも配る前に確定してください**。
- 推奨順:
  1. **独自ドメインを先に決めて、配信だけそこに置く**(自動更新・レジストラのロック・2要素認証)
  2. 当面 `workers.dev` で配るなら、**`workers.dev` のサブドメイン名を以後変えない**と決める(旧名が
     他人に取られうるかは Cloudflare の公式文書で確認できていません=未確認。変えない運用で避ける)
- 決めた値を `NEXT_PUBLIC_DELIVERY_ORIGIN` として控える(例: `https://adpop-delivery.<account>.workers.dev`)。
  **この値は、以後のビルドすべてで同じものを渡してください**(§7)。変えると、既に配ったタグとサムネイル
  表示(管理画面の CSP の `img-src`)の両方が食い違います。

## 6. secret を投入する(運用者の端末で・P2)

🔴 **この節だけは、AI 社員が代行しないでください。** `npm run admin:hash` は平文のパスワードを1回だけ
標準出力に表示する設計です。ターミナルで直接実行し、Bash ツール越し(会話ログに残る経路)では実行しないこと。

```bash
npm run admin:hash
#   表示されたパスワードはパスワード管理ツールへ保存する(この画面以外には出ません)
npx wrangler secret put ADMIN_PASSWORD_HASH -c wrangler.admin.jsonc    # ← 表示された値を貼る
npx wrangler secret put ADMIN_RATE_LIMIT_KEY -c wrangler.admin.jsonc   # ← 表示された値を貼る
npx wrangler secret put ADMIN_OWNER_ID -c wrangler.admin.jsonc        # ← 表示された値を貼る(最初の1回だけ)
npx wrangler secret put ADMIN_EMAIL -c wrangler.admin.jsonc           # ← ログインに使うメールアドレス
```

- secret 投入前は管理 API は 503 を返します(fail-closed。順序はこれで問題ありません)。
- ローカル開発用の `.dev.vars` は本番の secret と**別に**生成してください(同じ値を使い回さない)。

## 7. デプロイする

### 配信の Worker

```bash
npm run build:embed
npx wrangler deploy -c wrangler.delivery.jsonc
```

- `wrangler.delivery.jsonc` には `build.command` が設定されていません。**`npm run build:embed` を先に
  自分で実行してください**(忘れると `dist/delivery-assets` が無く、deploy はアセットディレクトリが
  存在しないエラーで失敗します=fail-closed。2026-10-05 実測)。

### 管理画面の Worker

```bash
NEXT_PUBLIC_DELIVERY_ORIGIN=<§5で決めた値> npx wrangler deploy -c wrangler.admin.jsonc
```

- 🔴 `wrangler.admin.jsonc` は `build.command` に
  `npm run build && node scripts/check-admin-headers.mjs` を設定してあります。**`wrangler deploy` を
  実行するだけで、埋め込み束ね → `next build` → `out/_headers` の CSP 組み立て → CSP の有無を見る検査が
  自動で走ります**(この PR で追加。本監査 P1 「`next build` だけで止めた `out/` が CSP 無しで出る」への対処)。
  `npm run build` を個別に走らせてから `wrangler deploy` を呼ぶ手順は不要になりましたが、`NEXT_PUBLIC_DELIVERY_ORIGIN`
  は**このコマンドを呼ぶシェルの環境変数として**渡してください(`build.command` は呼び出し元の環境変数を
  引き継ぎます)。
- ⚠ `build.command` は `wrangler dev`(ローカル開発)でも走ります(Wrangler の仕様。deploy 専用ではありません)。
  開発中に重いと感じたら、README の「動かし方(開発)」どおり `npm run build` を手で1回だけ走らせてから
  `admin:dev` を使う運用でも構いません(`build.command` はその場合も毎回走り直すので、ビルドが速いなら
  気にしなくて良い程度の差です)。
- 2026-10-05 実測: `node scripts/check-admin-headers.mjs` だけを単独で実行し、
  `out/_headers` を一時的にリネームして退避させると `NG  …/out/_headers が無い` で非ゼロ終了し、
  戻すと `OK` に戻ることを確認しました。`wrangler deploy -c wrangler.admin.jsonc --dry-run` でも
  `[custom build]` のログの中で `next build` → `build:admin-headers` → この検査の `OK` 行が
  実際に流れることを確認しています。

## 8. 動作確認(外形)

- 本番で1回ログインする(README の既存の注意: 本番の PBKDF2 反復上限はローカルの wrangler では再現できません)
- 未認証で `GET /api/admin/sites` を叩き、401 が返ること
- 画面(`/sites` など)の応答ヘッダに `Content-Security-Policy` があること
- R2 の公開(Public Development URL・カスタムドメイン)が有効になっていないこと(ダッシュボードで確認)
- `npx wrangler secret list -c wrangler.admin.jsonc` に4つの名前(`ADMIN_PASSWORD_HASH` /
  `ADMIN_RATE_LIMIT_KEY` / `ADMIN_OWNER_ID` / `ADMIN_EMAIL`)が出ること
- `preview_urls: false` / `workers_dev: true` / `routes` 未設定であること(両 `wrangler.*.jsonc` の既定どおり。
  Version URL を無効化し、`*.workers.dev` だけで出す。独自ドメインに `routes` を追加するのは、§5 で独自ドメインを
  選んだ場合のみ)

## preview_urls・workers.dev・routes の扱い

- **両 Worker とも `preview_urls: false` を明示しています。** 修正前の版(Version URL)を本番の secret・D1 の
  まま動かし続けさせないため(本監査 M7)。この手順でも変更しません。
- **`workers_dev: true` で、`routes` は設定していません。** つまり本番は `adpop-delivery.<account>.workers.dev` /
  `adpop-admin.<account>.workers.dev` だけで出ます。管理画面を独自ドメインに移す場合は `routes` を足し、
  `workers_dev` を `false` にしてください(README「管理画面は LP と別の登録ドメインに置いてください」)。
  `*.workers.dev` はそれぞれ PSL(Public Suffix List)掲載で別サイト扱いなので、workers.dev のままでも
  この要件は満たされています。
- 🔴 **このアカウントに他の Worker を増やさないこと。** 配信と管理画面が同じ `<account>.workers.dev` ゾーンに
  いるため、別の Worker を足すとそのゾーンの一部になり `SameSite=Strict` が効かなくなります(本監査 L5)。

## D1 の1日の書き込み上限について(受け入れて出す・P4)

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

## 次の本番適用で、まだ実行していないこと(Cloudflare の上の作業)

この PR の作業はすべて `--dry-run` / `--local` に限っています。次の実施者が実際に Cloudflare 上で行うのは:

- `wrangler d1 create adpop`(§2)・両設定ファイルへの `database_id` の反映
- `wrangler r2 bucket create adpop-images`(§3)
- `wrangler d1 migrations apply --remote`(§4。本番 D1 への実際の適用)
- `wrangler d1 execute --remote --command "PRAGMA optimize;"`(§4)
- `npm run admin:hash` と4つの `wrangler secret put`(§6。運用者の端末で)
- `wrangler deploy`(§7。両 Worker)
- §8 の外形確認
