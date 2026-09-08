# adpop-js(埋め込みスクリプト・MIT)

**このディレクトリだけが MIT。** リポジトリの他は AGPL-3.0(ルートの `LICENSE` / `LICENSING.md`)。

## いまの状態(PR1)

**中身はまだ無い。** ここに入るのは PR2 以降:

| ファイル | 役割 | いつ |
|---|---|---|
| `src/loader.ts` → `dist/t.js` | 全訪問者に配るローダ。トリガ判定と設定取得だけ | PR2 |
| `src/runtime.ts` → `dist/adpop.js` | 発火してから取りに行く本体(Shadow DOM でポップを描く) | PR2 |

## 守っている制約(要件書 §5-1 / §5-2 / §5-6)

| 制約 | どこで効かせているか |
|---|---|
| **gzip の上限**(ローダ 5KB / 本体 20KB / 合計 25KB) | `npm run check:bundle-size`(CI で毎 PR) |
| **依存ライブラリを入れない**(React も入れない) | `package.json` の `dependencies` は空 + `npm run check:embed-independence` |
| **AGPL 側(サーバー・管理画面)を import しない** | `npm run check:embed-independence`(CI で毎 PR) |

⚠ **PR1 の時点では中身が空**なので、サイズ検査は「上限を超えていないこと」を測っているだけで、
**まだ何も守っていない**。守り始めるのは PR2 で本体が入ってから。
⚠ `private: true` を外す(= npm に publish できる状態にする)のは**公開ゲート**(社長承認)の後。
