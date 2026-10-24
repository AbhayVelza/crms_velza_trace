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
  "approve",
  "territory",
] as const;
export type Action = (typeof ACTIONS)[number];

export const PERMISSIONS: Record<Action, Role[]> = {
  admin: ["ADMIN"],
  printOrder: ["OPERATOR"],
  verify: ["QC"],
  dispatch: ["OPERATOR", "SS", "DB", "SUPPLIER"],
  receive: ["SS", "DB", "SUPPLIER", "OUTLET"],
  openLot: ["SUPPLIER", "OUTLET"],
  reprint: ["OPERATOR"],
  void: ["OPERATOR"],
  device: ["OPERATOR", "ADMIN"],
  sync: ["OPERATOR"],
  stock: ["OPERATOR", "QC", "SS", "DB", "SUPPLIER", "OUTLET"],
  // The HQ dashboard is for Velza HQ only; every role gets its own portal and nothing else.
  dashboard: ["TRACE_OWNER"],
  search: ["TRACE_OWNER"],
  recall: ["TRACE_OWNER"],
  /** HQ approval of partner accounts (Admin approval happens when the Admin creates the account). */
  approve: ["TRACE_OWNER"],
  /** Super Stockist: see its assigned distributors. */
  territory: ["SS"],
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[action].includes(role);
}
