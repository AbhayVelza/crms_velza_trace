"use client";

// Every screen gets its own browser-tab title (WCAG 2.4.2), e.g. "Receive · Velza Traceability", so screen-reader
// users and people with many tabs know where they are. Screens are client pages and can't export `metadata`.

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { titleFor } from "@/lib/pageTitle";

export function PageTitle() {
  const pathname = usePathname();
  useEffect(() => {
    document.title = titleFor(pathname);
  }, [pathname]);
  return null;
}
