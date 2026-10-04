# PR3c Codex 1巡目対応 — 実物のスクリーンショット

Codex 1巡目(Blocker 2件・Should fix 7件)の修正結果と、main(#8 画像ポップの配信)への追従結果を撮ったもの。

| ファイル | 内容 |
|---|---|
| `01-image-pattern-thumbnail-after-save.png` | 新規の画像パターン: 画像未選択時は保存不可→画像を選ぶと下書きのままサムネイル表示→保存で配信Workerの`/img/<key>`から読んだサムネイルに切り替わる(Blocker 2・Should fix 2件:サムネイル表示・P-012) |
| `02-last-deliverable-variant-409.png` | 稼働中のポップの唯一の配信可能パターンをアーカイブしようとして409(`last_deliverable_variant`)。サーバーの文言「稼働中のポップには、配信できるパターンが1つ以上必要です。先に停止してください」をそのまま表示。画像の説明(imageAlt)も保存・リロード後も保持されている |
| `03-delete-confirm-countdown.png` | 完全削除の確認ダイアログ。2秒カウントダウン中はボタン無効(ラベルに秒数)、キャンセルは常時有効(Blocker 1) |

再現手順は `../pr3c/README.md` と同じ(ログイン→サイト/ポップ/パターンをAPI経由で作成→Playwrightで撮影)。
