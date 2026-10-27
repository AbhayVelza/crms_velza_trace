// Partner IDs and sign-in IDs. Every partner gets the next number of its role's sequence
// (DB0001, DB0002 …); numbers are never reused. A partner's sign-in ID is its partner ID,
// except the plant, which has one sign-in for the Operator (MF0001-OP) and one for QC (MF0001-QC).
// Velza staff have their own sequences (AD0001 for Admin, HQ0001 for HQ).

import type { PartnerType, Role } from "./types";

export const PARTNER_ID_PREFIX: Record<PartnerType, string> = {
  MANUFACTURER: "MF",
  SS: "SS",
  DB: "DB",
  RETAILER: "RT",
};

/** Velza staff have no partner; their sign-in IDs come from these sequences. */
export const STAFF_ID_PREFIX: Partial<Record<Role, string>> = { ADMIN: "AD", TRACE_OWNER: "HQ" };

/** The plant has two sign-ins, told apart by a suffix. */
export const PLANT_LOGIN_SUFFIX: Partial<Record<Role, string>> = { OPERATOR: "OP", QC: "QC" };

/** The sign-ins a new partner of this type gets. */
export const PARTNER_LOGIN_ROLES: Record<PartnerType, Role[]> = {
  MANUFACTURER: ["OPERATOR", "QC"],
  SS: ["SS"],
  DB: ["DB"],
  RETAILER: ["RETAILER"],
};

/** "DB" + 7 → "DB0007"; past 9999 the number simply grows ("DB10000"). */
export function formatSequenceId(prefix: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Sequence number must be a positive integer (got ${n})`);
  return `${prefix}${String(n).padStart(4, "0")}`;
}

/** Sign-in ID of a partner's login: the partner ID, or MF0001-OP / MF0001-QC at the plant. */
export function partnerLoginId(role: Role, partnerId: string): string {
  const suffix = PLANT_LOGIN_SUFFIX[role];
  return suffix ? `${partnerId}-${suffix}` : partnerId;
}

export const LOGIN_ID_RE = /^(MF|SS|DB|RT|AD|HQ)[0-9]{4,}(-(OP|QC))?$/;

/** Sign-in IDs are typed in any case and stored in capitals. */
export function normalizeLoginId(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isLoginId(raw: string): boolean {
  return LOGIN_ID_RE.test(normalizeLoginId(raw));
}

export const PASSWORD_MIN = 8;

/** Returns an error message, or null if the password is acceptable. */
export function checkPassword(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (pw.length > 128) return "Password must be at most 128 characters";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and digits";
  return null;
}

/** States and union territories of India (for partner addresses; one Super Stockist per state). */
export const INDIAN_STATES = [
  "Andaman and Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;
