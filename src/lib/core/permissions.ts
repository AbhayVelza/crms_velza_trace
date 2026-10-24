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
  dashboard: ["TRACE_OWNER", "ADMIN"],
  search: ["TRACE_OWNER", "ADMIN"],
  recall: ["TRACE_OWNER"],
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[action].includes(role);
}
