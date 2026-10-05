# `deploy/`

`delivery-origin.txt` — 配信ドメインの**確定値**を1か所だけ持つファイル。

- 初期値は `UNSET`(まだ確定していないことを表す)。
- 本番で配信の Worker を初めて deploy し、Cloudflare の workers.dev サブドメインが実在することを
  確認してから、確定した origin(`https://adpop-delivery.<account>.workers.dev`)をこのファイルに
  書いてコミットする。**それ以後は変えない。**
- 管理画面の deploy 前の検査(`scripts/check-admin-headers.mjs`)は、`NEXT_PUBLIC_DELIVERY_ORIGIN` が
  このファイルの値と**完全一致**しているかだけを見る(形だけの検査ではない)。ファイルが `UNSET` の
  ままなら deploy を止める。

手順の全体は [docs/deploy.md](../docs/deploy.md) §5 を見てください。
