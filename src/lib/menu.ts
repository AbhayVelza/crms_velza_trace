// Navigation per role. Each role sees only its own portal.

import type { Role } from "@/lib/core/types";

export interface MenuItem {
  href: string;
  label: string;
  description: string;
}

const receive: MenuItem = { href: "/receive", label: "Receive", description: "Scan IN lots and packs arriving at your location" };
const dispatch: MenuItem = { href: "/dispatch", label: "Dispatch", description: "Scan OUT down the chain with an invoice/challan" };
const openLot: MenuItem = { href: "/open-lot", label: "Open lot", description: "Open a case or tray so its packs can move one by one" };
const stock: MenuItem = { href: "/stock", label: "My stock", description: "Lots and packs at, leaving and arriving at your location" };
const damaged: MenuItem = { href: "/damaged", label: "Damaged", description: "Report a damaged case, tray or pack; see everything reported damaged here" };

export const MENU: Record<Role, MenuItem[]> = {
  ADMIN: [
    { href: "/admin/partners", label: "Partners", description: "Register partners (each gets its ID and sign-in) and assign them" },
    { href: "/admin/users", label: "Sign-ins & passwords", description: "Sign-in IDs, new passwords, Velza staff sign-ins" },
    { href: "/admin/devices", label: "Devices", description: "Manufacturer PCs that generate codes" },
    { href: "/admin/reference", label: "Countries & flavours", description: "Code lists used inside every code" },
    { href: "/admin/pools", label: "Batch code pools", description: "Issue random batch codes to devices" },
    { href: "/admin/settings", label: "Settings", description: "Alert threshold, sticker sizes, public URL" },
  ],
  OPERATOR: [
    { href: "/operator/new", label: "New print order", description: "Guided questions → batch codes → stickers" },
    { href: "/operator/orders", label: "Print orders", description: "History; open the print view again" },
    dispatch,
    { href: "/operator/reprint", label: "Reprint", description: "Reprint a damaged sticker (same code, reason logged)" },
    { href: "/operator/void", label: "Void lot", description: "Void an unpasted or misprinted lot" },
    stock,
    damaged,
  ],
  QC: [{ href: "/qc/verify", label: "Verify", description: "Scan a lot and each of its packs, then confirm" }, stock],
  SS: [receive, dispatch, stock, damaged, { href: "/my-partners", label: "My partners", description: "The distributors and retailers assigned to you and their stock" }],
  DB: [receive, dispatch, stock, damaged, { href: "/my-partners", label: "My retailers", description: "The retailers assigned to you and their stock" }],
  RETAILER: [receive, openLot, stock, damaged],
  TRACE_OWNER: [
    { href: "/hq", label: "Dashboard", description: "Status counts, stock by location, in transit, alerts" },
    { href: "/hq/search", label: "Search code", description: "Status, location, parent/children and full timeline" },
    { href: "/hq/alerts", label: "Alerts", description: "Not received, wrong receiver, unknown, duplicate, blocked" },
    { href: "/hq/batches", label: "Batches & recall", description: "Batch report and recall" },
    { href: "/hq/scans", label: "Scan audit", description: "Every scan, success or failure" },
  ],
};

/** Pages every signed-in user may open, whatever the role. */
export const COMMON_PATHS = ["/", "/account"];

/** Which roles may open a path (anything else shows "not part of your portal"). */
export function rolesForPath(pathname: string): Role[] {
  const roles = (Object.keys(MENU) as Role[]).filter((r) =>
    MENU[r].some((m) => pathname === m.href || (m.href !== "/hq" && pathname.startsWith(m.href + "/")) || (m.href === "/hq" && pathname === "/hq")),
  );
  return roles;
}
