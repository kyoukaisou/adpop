"use client";

/*
  ルート。セッションがあれば /sites へ、無ければ /login へ送るだけ(静的書き出しなので判定はクライアント側)。
*/
import { useEffect } from "react";
import { getJson } from "./_lib/api";

export default function Home() {
  useEffect(() => {
    getJson("/session").then((res) => {
      window.location.href = res.ok ? "/sites" : "/login";
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="sr-only">ADPOP</h1>
    </main>
  );
}
