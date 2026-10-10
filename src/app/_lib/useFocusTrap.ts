"use client";

/*
  モーダル・ドロワー共通の3点セット(画面設計 §5 申し送り1・§9-3-2 申し送り2):
  開く前のフォーカス位置への復帰・初期フォーカス・フォーカストラップ(Tab循環)・Escで閉じる。
  🔴 これまで `Modal.tsx` の中に直接書いていたロジックをここへ切り出した(D-384)。
    390px の新しいドロワー(`Drawer.tsx`)にも**同じ規律**を適用するため、2箇所に書き写して
    片方だけ直し忘れる事故を避ける(1本化)。振る舞いは変えていない。
*/
import { useEffect, useRef } from "react";

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * @param active 開いているか(false の間は何もしない。トグルで開閉するドロワーのため)
 * @param onClose Esc が押されたときに呼ぶ
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onClose: () => void) {
  const containerRef = useRef<T>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const first = container ? focusableElements(container)[0] : undefined;
    first?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || containerRef.current === null) return;
      const items = focusableElements(containerRef.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);

  return containerRef;
}
