import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PR2 = 配信エンドポイント(`src/app/api/v1/*`)+ 埋め込みスクリプト。管理画面は PR3。
  async headers() {
    return [
      {
        /*
          埋め込みスクリプト(`public/embed/*.js` = `scripts/build-embed.mjs` の出力)。
          🔴 **短めのキャッシュにする(5分)。**
            ・長くすると、**壊れた版を配ったときに戻すのが遅くなる**(他人の LP に載っている)
            ・短すぎると、全訪問者が毎回取りに行く(要件書 §5-1 の「軽さ」に反する)
          ⚠ ここは実測ではなく本部が置いた設計値。**訪問が増えたら数字を見て決め直す。**
          ⚠ 設定 JSON(`/api/v1/config`)は**キャッシュしていない** —— あちらは
            サイトキー × Origin の認可の結果なので、無効化の手順を決める PR まで入れない。
        */
        source: "/embed/:file*",
        headers: [{ key: "cache-control", value: "public, max-age=300, s-maxage=300" }],
      },
    ];
  },
};

export default nextConfig;
