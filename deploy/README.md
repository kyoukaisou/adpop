# `deploy/`

`delivery-origin.txt` — 配信ドメインの**確定値**を1か所だけ持つファイル。

- 現在の確定値は `https://adpop.kyoukaisou.dev`(独自ドメインの Custom Domain)。**それ以後は変えない。**
  自分の環境に fork して立てる場合は、自分が持つドメインのホスト名に書き換えること。
- `UNSET` という値は「まだ確定していない」ことを表す予約語として検査(`scripts/delivery-origin-guard.mjs`)
  に残っている。初めて別の環境に立てる人が、確定するまでの間だけこの値を置く。
- 管理画面の deploy 前の検査(`scripts/check-admin-headers.mjs`)は、`NEXT_PUBLIC_DELIVERY_ORIGIN` が
  このファイルの値と**完全一致**しているかだけを見る(形だけの検査ではない)。ファイルが `UNSET` の
  ままなら deploy を止める。
- 両 Worker の deploy 前の検査(`scripts/check-custom-domain.mjs`)は、このファイルの値(スキームを
  外したホスト名)と、配信の Worker の Custom Domain の `routes` が完全一致しているかも見る。

手順の全体は [docs/deploy.md](../docs/deploy.md) §5 を見てください。
