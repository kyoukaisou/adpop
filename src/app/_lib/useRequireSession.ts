"use client";

import { useEffect, useState } from "react";
import { getJson } from "./api";

export type SessionState = "checking" | "ready";

/** 認証済みの画面の先頭で呼ぶ。未認証ならログインへ送る(サーバーが既定で拒否するので、ここは利便性のためだけ)。 */
export function useRequireSession(): SessionState {
  const [state, setState] = useState<SessionState>("checking");
  useEffect(() => {
    let active = true;
    getJson("/session").then((res) => {
      if (!active) return;
      if (res.ok) {
        setState("ready");
      } else {
        window.location.href = "/login";
      }
    });
    return () => {
      active = false;
    };
  }, []);
  return state;
}
