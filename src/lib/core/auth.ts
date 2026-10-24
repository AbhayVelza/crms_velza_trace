// Account rules: who needs approval, when an account may sign in, sign-in ID and password policy.
// Pure functions; hashing and sessions live in the services.

import { ROLE_PARTNER_TYPE, type Role, type User } from "./types";

/** Partner accounts (everyone in the distribution line) need Admin + HQ approval; Velza staff don't. */
export function needsApproval(role: Role): boolean {
  return ROLE_PARTNER_TYPE[role] !== null;
}

export type AccountStatus = "DISABLED" | "NO_PASSWORD" | "REJECTED" | "PENDING_ADMIN" | "PENDING_HQ" | "APPROVED";

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  DISABLED: "Disabled",
  NO_PASSWORD: "No password set",
  REJECTED: "Rejected by HQ",
  PENDING_ADMIN: "Waiting for Admin approval",
  PENDING_HQ: "Waiting for HQ approval",
  APPROVED: "Approved",
};

type StatusFields = Pick<User, "role" | "active" | "adminApprovedAt" | "hqApprovedAt" | "rejectedAt"> & { hasPassword: boolean };

export function accountStatus(u: StatusFields): AccountStatus {
  if (!u.active) return "DISABLED";
  if (!u.hasPassword) return "NO_PASSWORD";
  if (!needsApproval(u.role)) return "APPROVED";
  if (u.rejectedAt) return "REJECTED";
  if (!u.adminApprovedAt) return "PENDING_ADMIN";
  if (!u.hqApprovedAt) return "PENDING_HQ";
  return "APPROVED";
}

export function canSignIn(u: StatusFields): boolean {
  return accountStatus(u) === "APPROVED";
}

/** Message shown on the sign-in screen when the password was right but the account can't be used. */
export function signInBlockedMessage(status: AccountStatus): string {
  switch (status) {
    case "DISABLED":
      return "This account is disabled. Contact Velza Admin.";
    case "NO_PASSWORD":
      return "No password has been set for this account. Contact Velza Admin.";
    case "REJECTED":
      return "This account was not approved by Velza HQ. Contact Velza Admin.";
    case "PENDING_ADMIN":
      return "This account is waiting for Velza Admin approval.";
    case "PENDING_HQ":
      return "This account is waiting for Velza HQ approval.";
    case "APPROVED":
      return "";
  }
}

export const LOGIN_ID_RULE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export function normalizeLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function checkLoginId(raw: string): string | null {
  return LOGIN_ID_RULE.test(normalizeLoginId(raw)) ? null : "Sign-in ID: 3–40 characters, letters, digits, dot, dash or underscore";
}

export const PASSWORD_MIN = 8;

/** Returns an error message, or null if the password is acceptable. */
export function checkPassword(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (pw.length > 128) return "Password must be at most 128 characters";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and digits";
  return null;
}

/** Fields that, when an Admin changes them, send a partner account back to HQ for approval. */
export const REAPPROVAL_FIELDS = ["role", "partnerId"] as const;
