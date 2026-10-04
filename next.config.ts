import type { NextConfig } from "next";

// ⚠ 配信(`/api/v1/*`・`/embed/*`)はこのアプリではない。配信の Worker(src/delivery/worker.ts)が持つ。
//   このアプリは管理画面(PR3c)。
// 🔴 Next の静的書き出し(設計 ADPOP-PR3b-設計 改訂v2 §0)。管理画面の Worker の静的配信に載せる。
//   動的ルート([id] 等)は書き出し時に id が決まらないため作らない。画面の URL はクエリで id を渡す
//   (`/site?id=…` 等)。Server Actions・SSR・middleware は静的書き出しでは動かない。
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
