"use client";

// Page transition on route change (Motion): the new page fades in. Nothing remounts (state, scroll and
// Suspense behave as before) and navigation is never delayed: the new page is already rendered, it just eases
// in. Skipped on the first load. Search-param changes on the same page do not replay it.

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
    // Opacity only. Any transform here (even mid-animation) makes this div the containing block for fixed
    // children and shifts sticky ones with the page, so headers would slide for the length of the transition.
    const controls = animate(scope.current, { opacity: [0, 1] }, { duration: reduced ? 0.25 : 0.35, ease: EASE_OUT });
    // A quick second navigation finishes this fade rather than freezing the page half-transparent.
    return () => controls.complete();
  }, [pathname, reduced, animate, scope]);

  return <div ref={scope}>{children}</div>;
}
