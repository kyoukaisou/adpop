import type { NextConfig } from "next";

// ⚠ 配信(`/api/v1/*`・`/embed/*`)はこのアプリではない。配信の Worker(src/delivery/worker.ts)が持つ。
//   このアプリは管理画面(PR3b)の土台。
const nextConfig: NextConfig = {};

export default nextConfig;
