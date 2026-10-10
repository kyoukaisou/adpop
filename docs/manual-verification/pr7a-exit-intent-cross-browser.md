# PR7a 離脱検知: 実機ブラウザでの確認手順

## 背景

PR7a は「離脱検知が本番の Chrome で一度も発火しなかった」ことへの対処として、`mouseout` から
`document.documentElement` の `mouseleave`(主)+ `document` の `mouseout`(控え。主が届かないブラウザ
向けのフォールバック)の2本立てに変えた(packages/embed/src/loader.ts)。

🔴 **Codex クロスレビュー1巡目(2026-10-10)で、`document` 直付けの `mouseleave` は Safari(WebKit
bug 120862 で意図的に Document へ送らない仕様)・Firefox(`document` では動かず `documentElement`
でのみ動くという報告)では届かない、という一次情報の指摘があった。** それを受けて主を
`documentElement` に、旧実装(`document` の `mouseout`)を控えに変更した。

⚠️ **このドキュメントの範囲**: このリポジトリの自動テスト(vitest + jsdom)は、ブラウザが実際に
どのイベントをどの要素へ配送するかそのものは確かめられない(jsdom はテストコードが明示的に
`dispatchEvent` した通りにしか動かない)。「実機の Chrome・Edge・Firefox・Safari で、ページ外へ
本当にマウスを動かしたときに、主(documentElement の mouseleave)か控え(document の mouseout)の
どちらかが実際に発火するか」は、2026-10-10 時点で実機確認していない。以下はその確認手順。

🔴 **Codex クロスレビュー2巡目(2026-10-10)で、以前の版の手順(ビルドした `t.js` を適当な静的
サーバーで配る)では `/api/v1/config` が取れず `arm()` に届かない=リスナーが一度も登録されない、
という指摘があった。この版は2段に分け、1段目はビルド・config取得を一切不要にした。**

## 1段目: ブラウザのネイティブ配送だけを確かめる(ビルド不要)

ADPOP のコード・ビルドには依存しない。どんなページでも、DevTools のコンソールから直接確かめられる。

1. 任意のページ(どのサイトでもよい)を開き、DevTools のコンソールを開く。
2. 次を貼って実行する(`documentElement` の `mouseleave` と `document` の `mouseout` の両方に、
   見分けのつくログを直接登録する)。

   ```js
   document.documentElement.addEventListener("mouseleave", (e) => {
     console.log("[主:documentElement mouseleave]", "relatedTarget=", e.relatedTarget, "clientY=", e.clientY);
   });
   document.addEventListener("mouseout", (e) => {
     console.log("[控え:document mouseout]", "relatedTarget=", e.relatedTarget, "clientY=", e.clientY);
   });
   ```

3. マウスカーソルを**ウィンドウの外**(ブラウザのタブ・アドレスバー・OSのメニューバー方向)へ、
   上端から出す。次の2パターンを**両方**試す(**どちらも必須**。片方だけでは合格にしない):
   - ゆっくり上端から出る
   - 速く(本番で問題になった条件に近い)上端から出る
4. 対象ブラウザ: **Chrome・Edge・Firefox・Safari** の4つ。
5. それぞれのブラウザ・それぞれの速さで、コンソールに出たログ(主/控え/両方/どちらも出ない)と、
   `relatedTarget`(`null` であることを確認)・`clientY`(0に近い値か)を、下の表に記録する。
6. **合格条件**: 4ブラウザ × 2パターン(ゆっくり/速い)の**すべての組み合わせ**で、主か控えの
   どちらかが(両方でもよい)ログに出ること。1つでも両方とも出なければ、そのブラウザ・その速さでは
   離脱検知が機能しない=本部へ Blocker として報告する。

## 2段目: 実際の ADPOP で、ポップが出るところまで確かめる

1段目はブラウザのイベント配送だけを見ている。2段目は、実際にタグを読み込ませてポップが出るかまで確かめる。

### 前提

- 管理画面でサイトを1つ用意し、**許可ドメインに自分が開けるページ(自分の管理下にあるページ)を
  登録**しておく。
- そのサイトに**稼働中(status=active)のポップを1つ以上**用意しておく(稼働中が0件だと配信の
  config が 403 を返し、何も起きない。PR7a の2点目の変更そのもの)。
- 頻度制御(`sessionImpressions`/`suppressDays`)により、**一度ポップを見た同じブラウザでは
  しばらく(既定で7日間)再表示されない**。2回目以降を確かめるときはシークレットウィンドウ
  (プライベートブラウズ)を使うか、ブラウザのサイトデータ(`localStorage`)を消してから試す。

### 手順

1. 許可ドメインに登録した、自分のページ(本番 or それに準ずる環境)を開く。
2. DevTools のコンソールで、埋め込みタグを一時的に読み込ませる(ページを保存し直さず、その場で
   1行だけ実行する。管理画面の「埋め込みタグ」に表示されている `<script>` の `src` と
   `data-adpop-site` の値をそのまま使う):

   ```js
   const s = document.createElement("script");
   s.async = true;
   s.src = "<埋め込みタグに表示されている src の値>";
   s.setAttribute("data-adpop-site", "<埋め込みタグに表示されている data-adpop-site の値>");
   document.head.appendChild(s);
   ```

3. 1段目と同じく、ゆっくり/速い の両方で上端から外へ出す。
4. 対象ブラウザ: **Chrome・Edge・Firefox・Safari** の4つ。
5. **合格条件**: 4ブラウザ × 2パターン(ゆっくり/速い)の**すべての組み合わせ**で、ポップ本体が
   実際に出ること(1回出したら頻度制御に引っかかるので、次の組み合わせへ進む前にシークレット
   ウィンドウを開き直すなどしてリセットする)。

## 結果の記録

### 1段目(ネイティブ配送)

| ブラウザ | 移動の速さ | 届いたイベント(主/控え/両方/なし) | relatedTarget | clientY |
|---|---|---|---|---|
| Chrome | ゆっくり | | | |
| Chrome | 速い | | | |
| Edge | ゆっくり | | | |
| Edge | 速い | | | |
| Firefox | ゆっくり | | | |
| Firefox | 速い | | | |
| Safari | ゆっくり | | | |
| Safari | 速い | | | |

### 2段目(実際の ADPOP)

| ブラウザ | 移動の速さ | 届いたイベント(主/控え/両方/なし) | ポップが出たか |
|---|---|---|---|
| Chrome | ゆっくり | | |
| Chrome | 速い | | |
| Edge | ゆっくり | | |
| Edge | 速い | | |
| Firefox | ゆっくり | | |
| Firefox | 速い | | |
| Safari | ゆっくり | | |
| Safari | 速い | | |

まだ誰も実施していない(2026-10-10 時点)。実施したら、確認日・担当・ブラウザのバージョンも
このファイルに追記する。
