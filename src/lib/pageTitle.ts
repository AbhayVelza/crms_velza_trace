// Browser-tab title for each screen (WCAG 2.4.2), built from the menu labels.

import { MENU } from "@/lib/menu";

export const APP_TITLE = "Velza Traceability";
const EXTRA: Record<string, string> = { "/": "Overview", "/account": "My account" };
const LABELS = new Map<string, string>(Object.entries(EXTRA));
for (const items of Object.values(MENU)) for (const m of items) if (!LABELS.has(m.href)) LABELS.set(m.href, m.label);

/** The label of the longest menu path that the current path starts with (/operator/orders/123 → Print orders). */
export function titleFor(pathname: string): string {
  let best = "";
  for (const href of LABELS.keys()) {
    const hit = pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
    if (hit && href.length > best.length) best = href;
  }
  const label = best ? LABELS.get(best) : undefined;
  return label ? `${label} · ${APP_TITLE}` : APP_TITLE;
}
