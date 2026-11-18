"use client";

// Page transition on route change (Motion): the new page fades and lifts in. Nothing remounts (state, scroll and
// Suspense behave as before) and navigation is never delayed: the new page is already rendered, it just eases
// in (a plain fade under reduced motion). Skipped on the first load. Search-param changes on the same page do not replay it.

import { useAnimate, useReducedMotion } from "motion/react";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { EASE_OUT } from "./motion";

export function PageFade({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduced = useReducedMotion();
  const first = useRef(true);

  // Before paint, so the new page never shows for a frame at full opacity first.
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!scope.current) return;
    // Reduced motion: a plain fade. Otherwise fade and lift. Transform is cleared at the end, so fixed and
    // sticky children behave normally once it settles.
    const controls = animate(scope.current, reduced ? { opacity: [0, 1] } : { opacity: [0, 1], y: [16, 0] }, { duration: reduced ? 0.25 : 0.4, ease: EASE_OUT });
    controls.then(() => {
      if (scope.current) scope.current.style.transform = "";
    });
    return () => controls.stop();
  }, [pathname, reduced, animate, scope]);

  return <div ref={scope}>{children}</div>;
}
