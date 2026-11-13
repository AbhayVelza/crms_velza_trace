// Which roles may perform which action. Used by services (enforced) and the UI menu.

import type { Role } from "./types";

export const ACTIONS = [
  "admin",
  "printOrder",
  "verify",
  "dispatch",
  "receive",
  "openLot",
  "reprint",
  "void",
  "device",
  "sync",
  "stock",
  "dashboard",
  "search",
  "recall",
  "territory",
  "damage",
  "container",
  "details",
] as const;
export type Action = (typeof ACTIONS)[number];

export const PERMISSIONS: Record<Action, Role[]> = {
  admin: ["ADMIN"],
  printOrder: ["OPERATOR"],
  verify: ["QC"],
  dispatch: ["OPERATOR", "WAREHOUSE", "SS", "DB"],
  receive: ["WAREHOUSE", "SS", "DB", "RETAILER"],
  openLot: ["RETAILER"],
  reprint: ["OPERATOR"],
  void: ["OPERATOR"],
  device: ["OPERATOR", "ADMIN"],
  sync: ["OPERATOR"],
  stock: ["OPERATOR", "QC", "WAREHOUSE", "SS", "DB", "RETAILER"],
  // The HQ dashboard is for Velza HQ only; every role gets its own portal and nothing else.
  dashboard: ["TRACE_OWNER"],
  search: ["TRACE_OWNER"],
  recall: ["TRACE_OWNER"],
  /** See the partners assigned to you: SS → its distributors and direct retailers, DB → its retailers. */
  territory: ["SS", "DB"],
  /** Report damaged cases, trays and packs held at your location. */
  damage: ["OPERATOR", "WAREHOUSE", "SS", "DB", "RETAILER"],
  /** Shipping containers plant → Velza Warehouse: the operator loads and dispatches them; the warehouse and HQ follow them. */
  container: ["OPERATOR", "WAREHOUSE", "TRACE_OWNER"],
  /** Scan a code to see its product details (batch, dates) and the partners it came through to reach you. */
  details: ["OPERATOR", "QC", "WAREHOUSE", "SS", "DB", "RETAILER"],
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[action].includes(role);
}
