# PR6a スクリーンショットの撮り方(再現手順)

管理画面を実際に立ち上げ、ダミーの数字を入れてから撮った(API のモックではない)。

```bash
# 1. 管理者の秘密を作る(対話なし版。パスワードが標準出力に出る)
node -e "
import('./scripts/admin-hash.mjs').then(async (m) => {
  const s = await m.generateSecrets();
  const fs = await import('node:fs');
  fs.writeFileSync('.dev.vars', \`ADMIN_PASSWORD_HASH=\${s.passwordHash}
ADMIN_RATE_LIMIT_KEY=\${s.rateLimitKey}
ADMIN_OWNER_ID=\${s.ownerId}
ADMIN_EMAIL=test@example.com
\`);
  console.log('PASSWORD=' + s.password);
});
"

# 2. ローカル D1 にマイグレーションを当てる
npm run admin:migrate:local

# 3. ビルド(out/_headers もここで作られる)
NEXT_PUBLIC_DELIVERY_ORIGIN="https://adpop-delivery.<account>.workers.dev" npm run build

# 4. 管理画面の Worker をローカルで起動
npx wrangler dev -c wrangler.admin.jsonc --port 8799

# 5. ログインしてサイト・ポップ・パターンを作る(API を直接叩く。手順は省略)
#    表示/クリック/閉じたの数字は、`events` テーブルへ直接 INSERT して作った
#    (wrangler d1 execute --local -c wrangler.admin.jsonc --file <生成したSQL>)。
#    直近7日分(active)と、90日以内に分散させた累計分(archived)を別々に入れている。

# 6. Playwright でログイン済み Cookie を使って各画面を開き、スクリーンショットを撮る
#    (コンソールの `Content Security Policy` / `Refused to` の文字列を監視し、
#     CSP 違反が0件であることも同時に確認した)
```

## ファイル

| ファイル | 画面 |
|---|---|
| `01-popups-1280.png` / `01-popups-390.png` | サイト内・ポップ一覧(直近7日の数字入り) |
| `02-archived-1280.png` | アーカイブ済み展開(累計の数字入り) |
| `03-delete-confirm-1280.png` / `03-delete-confirm-390.png` | 完全に削除の確認(「表示 N・クリック N・閉じた N」の文言) |
| `04-unsaved-changes-dialog-1280.png` | ポップ編集で未保存のままパンくずを押したときの確認モーダル |

## 確認したこと(スクリーンショット以外)

- 上の全画面で、ブラウザのコンソールに CSP 違反(`Content Security Policy` / `Refused to`)が0件。
- パンくず・ログアウトをキャンセル → 画面に留まり、未保存の入力はそのまま残る。
- パンくず・ログアウトを確定 → 1回だけ確認が出て(ネイティブの `beforeunload` ダイアログは重ねて出ない)、
  実際に遷移する。
- 確認を経由しない再読み込み(F5 相当)→ ブラウザ自身の `beforeunload` 確認が出る。
