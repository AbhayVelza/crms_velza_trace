"use client";

// A short fade of the page content when the route changes. Nothing remounts (state, scroll and Suspense behave
// as before) and navigation is never delayed: the new page is already rendered, it just eases in. Skipped on
// the first load and under reduced motion. Search-param changes on the same page do not replay it.

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, type ReactNode } from "react";

export function PageFade({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Before paint, so the new page never shows for a frame at full opacity first.
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = box.current;
    if (!el?.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // --duration-base / --ease-out-soft in globals.css (opacity only: no transform, so fixed and sticky children are unaffected).
    const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    return () => fade.cancel();
  }, [pathname]);

  return <div ref={box}>{children}</div>;
}
