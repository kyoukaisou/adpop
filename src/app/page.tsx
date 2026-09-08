/*
  PR1(骨格)の唯一のページ。**管理画面ではない。**

  🔴 ここに画面を足さない。管理画面は PR3、配信エンドポイントは PR2。
  このページが在る理由は、`next build` と `npm run typecheck` が
  「App Router のアプリとして成立していること」を毎 PR 測れる状態にするため
  (app ディレクトリにページが1つも無いとビルドが成立しない)。
*/
export default function Home() {
  return (
    <main>
      <h1>ADPOP</h1>
      <p>骨格のみ。管理画面と配信エンドポイントはまだ実装されていません。</p>
    </main>
  );
}
