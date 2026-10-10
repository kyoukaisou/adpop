/*
  旧 `/site?id=...` の互換転送先(D-384 Codexレビュー指摘2)。
  DOM・Reactに依存しない純粋関数にして、転送先の文字列をテストで固定できるようにする。
*/
export function legacySiteRedirectTarget(siteId: string): string {
  return siteId === "" ? "/sites" : `/popups?site=${siteId}`;
}
