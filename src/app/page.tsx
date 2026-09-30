/*
  管理画面(PR3b)が入るまでの仮のページ。
  このページが在る理由は、`next build` と `npm run typecheck` が
  「App Router のアプリとして成立していること」を毎 PR 測れる状態にするため。
  ⚠ 配信(`/api/v1/*`・`/embed/*`)はこのアプリではなく、配信の Worker(`src/delivery/worker.ts`)。
*/
export default function Home() {
  return (
    <main>
      <h1>ADPOP</h1>
    </main>
  );
}
