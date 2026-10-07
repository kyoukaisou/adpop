# PR3c 実物のスクリーンショット

PR本文に貼るための撮影済み画像。承認済みの見本(HTML静的モック)との対比用。

## 撮り方(再現手順)

```bash
# 1) 管理者の秘密を作り .dev.vars に書く(リポジトリのREADME参照)
npm run admin:hash
#   → .dev.vars に ADMIN_PASSWORD_HASH / ADMIN_RATE_LIMIT_KEY / ADMIN_OWNER_ID / ADMIN_EMAIL を書く

# 2) ローカルD1にマイグレーションを当てる
npm run admin:migrate:local

# 3) 画面をビルドして管理画面のWorkerを起動する(http://localhost:8787 既定。ここでは8799で起動した)
npm run build
npx wrangler dev -c wrangler.admin.jsonc --port 8799

# 4) ログインしてセッションCookieを取得(curlで事前にログインし、cookie jarを使う)
curl -s -i -X POST http://localhost:8799/api/admin/login \
  -H "Content-Type: application/json" -H "Origin: http://localhost:8799" \
  -d '{"email":"<ADMIN_EMAILの値>","password":"<admin:hashが表示したパスワード>"}' \
  -c /tmp/adpop-cookie.txt

# 5) curlでサイト・ポップ・パターンをいくつか作る(/api/admin/sites 等。Originヘッダ必須)

# 6) Playwright(npm install --no-save playwright のうえで)でスクリーンショットを撮る。
#    storageState にセッションCookieを入れて1280px/390pxのビューポートで goto → screenshot
```

## 一覧

| ファイル | 画面 | 見本との対応 |
|---|---|---|
| `01-login-*.png` | ログイン | `01-login-*.png` |
| `02-sites-*.png` | サイト一覧(稼働中チップ・稼働ポップなし） | `02-sites-*.png` |
| `02b-sites-new-1280.png` | サイトを追加モーダル(フォーカストラップ込み） | `02b-sites-new-1280.png` |
| `03-popups-*.png` | サイト内・ポップ一覧 | `03-popups-*.png` |
| `03c-popups-archived-1280.png` | アーカイブ済み展開 | `03c-popups-archived-1280.png` |
| `03d-popups-delete-confirm-countdown-1280.png` | 完全削除の確認(2秒カウントダウン中・ボタン無効） | `03d-popups-delete-confirm-1280.png` |
| `03d-popups-delete-confirm-ready-1280.png` | 完全削除の確認(カウントダウン後・ボタン有効） | 同上 |
| `04-popup-edit-full-1280.png` / `04-popup-edit-390.png` | ポップ編集(設定+パターン） | `04-popup-edit-*.png` |
| `07a-popup-edit-image-draft-1280.png` | パターン追加→画像種別の下書き(URL未入力のため画像選択が無効) | `07a-popup-edit-image-empty-v2-1280.png` |

⚠ 表示/クリック/閉じたの数字は「—」(集計エンドポイントが無いため。README参照)。
