# PR7a スクリーンショット(稼働中のポップが0件のときの案内)

## 画像一覧

| ファイル | 内容 | 幅 |
|---|---|---|
| `01-site-no-active-popup-1280.png` | サイト画面。ポップは2件あるが、どちらも停止/下書き = 稼働中が0件 | 1280 |
| `01-site-no-active-popup-390.png` | 同上 | 390 |

## 撮り方(再現手順)

実装済みの `/site` ページそのものを、`playwright-core`(`repos/nailkarte` の `node_modules` を絶対パスで借用。PR6a と同じ道具)で開き、`/api/admin/*` を `page.route` でモックして撮影した。静的モックではなく、実際の React コンポーネントを描画している。

```js
import { chromium } from "<repos/nailkarte>/node_modules/playwright-core/index.mjs";

const SITE = { id: "site-1", name: "サンプルLP", siteKey: "0123456789abcdef0123456789abcdef", allowedOrigins: ["https://example.com"] };
// 🔴 稼働中のポップが0件(status が draft/paused のみ)を再現する
const POPUPS = [
  { id: "popup-1", name: "初回割引ポップ", status: "paused", archivedAt: null },
  { id: "popup-2", name: "下書き中のポップ", status: "draft", archivedAt: null },
];

// NEXT_PUBLIC_DELIVERY_ORIGIN を設定した状態で `npm run dev` を起動しておく
// (未設定だと「配信先が未設定です」の帯も一緒に出てしまい、今回見たい帯と見分けにくくなるため)

// page.route で /api/admin/session, /sites/:id, /sites/:id/popups, /sites/:id/popups/stats を上のデータで fulfill
// → http://localhost:3000/site?id=site-1 を開いて 1280 / 390 の viewport で screenshot
```

## この道具の実力(言えること / 言えないこと)

- ✅ 実際にビルドした Next.js の開発サーバー上で、本物の React コンポーネント(`src/app/site/page.tsx`)が実際の Tailwind クラスで描いた見た目。
- ✅ 「ポップが1件もない」ケース(`EmptyState` のみ表示・この案内の帯は出ない)も別途確認済み(PR本文に記載。その撮影は再現用に保存していない)。
- ❌ 実際のログイン・保存等の操作の挙動(API はモックなので、保存後の再取得などは試していない)。
- ❌ Safari/iOS の実機での見え方。
