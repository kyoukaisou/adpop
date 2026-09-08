/*
  ADPOP のローダ(`t.js`)—— **全訪問者に配る側**。MIT(このディレクトリのみ)。

  🔴 PR1 では中身を入れない(要件書 §11: PR1 に埋め込みスクリプトは入れない)。
  PR2 で入るのは「トリガ判定 + 設定取得 + 発火してから本体を取りに行く」だけ。

  ここに書いてはいけないもの(要件書 §5-1 / §5-2):
    ・依存ライブラリ(React も含む)
    ・`document.write` / 同期 XHR
    ・`window` への名前空間1つを超える書き込み
    ・AGPL 側(`src/`)からの import —— ライセンスが混ざる(`LICENSING.md`)
*/
export const ADPOP_LOADER_VERSION = "0.0.0";
