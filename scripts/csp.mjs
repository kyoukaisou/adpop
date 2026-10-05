#!/usr/bin/env node
/*
  管理画面の CSP を組み立てる純粋関数。
  設計: notes/プロダクト事業部/ADPOP-PR3b-設計.md 改訂v2 §6 #5(M8)。
  security 監査: notes/本部/セキュリティ監査-ADPOP-PR3b-2026-10-01.md §0 #5(実測: Next の静的書き出しは
  1ページにつきインライン `<script>` を2本出す。中身はビルド時に決まる定数)。

  🔴 手で書き写さない: ハッシュはビルドのたびに実物の HTML から数える(`scripts/build-admin-headers.mjs`)。
  🔴 unsafe-inline・unsafe-eval・ワイルドカードは使わない。
*/
import { createHash } from "node:crypto";

/**
 * HTML 文字列から、`src` 属性を**持たない** `<script>` タグの中身だけを全部取り出す。
 * Next の静的書き出しは RSC のペイロード(`self.__next_f.push(...)`)をこの形で出す(実測)。
 * `src` を持つ外部 script(`_next/static/chunks/*.js`)は対象外(`script-src 'self'` が別途許可する)。
 */
export function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  return scripts;
}

/** CSP の `script-src` に書く `'sha256-<base64>'` の形。中身1文字でも変われば別の値になる。 */
export function scriptHashToken(scriptText) {
  const digest = createHash("sha256").update(scriptText, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

/** 複数 HTML の中身から、重複を除いたハッシュの一覧を作る(決定的な順番 = ソート済み)。 */
export function collectScriptHashes(htmlContents) {
  const set = new Set();
  for (const html of htmlContents) {
    for (const script of extractInlineScripts(html)) {
      set.add(scriptHashToken(script));
    }
  }
  return [...set].sort();
}

/**
 * CSP の骨格(M8)。
 * - `default-src 'none'` を起点に、使っている経路だけを明示で許可する。
 * - `script-src` はハッシュだけ(`'unsafe-inline'` は使わない)。
 * - `style-src`/`font-src` は `'self'`(管理画面は外部スタイルシート・自前ホストのフォントのみ。
 *   インラインの `style` 属性は使わない設計——`VariantCard` の進捗バーは `<progress>` の value 属性に
 *   変えてある。globals.css 参照)。
 * - `img-src` は `'self'` に加えて、設定済みなら配信の Worker のオリジン(サムネイル。delivery.ts 参照)。
 * - `connect-src 'self'`(管理 API は同じオリジン)。
 */
export function buildCsp({ scriptHashes, deliveryOrigin }) {
  const scriptSrc = ["'self'", ...scriptHashes].join(" ");
  const imgSrc = ["'self'", ...(deliveryOrigin ? [deliveryOrigin] : [])].join(" ");
  return [
    `default-src 'none'`,
    `script-src ${scriptSrc}`,
    `style-src 'self'`,
    `font-src 'self'`,
    `img-src ${imgSrc}`,
    `connect-src 'self'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
  ].join("; ");
}
