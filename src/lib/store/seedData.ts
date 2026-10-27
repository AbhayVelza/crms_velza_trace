// Base seed: the reference data every installation needs, and nothing made up.
// Country 91 and the four flavour codes, default settings, and two Velza staff sign-ins:
// Velza Admin (AD0001) and Velza HQ (HQ0001). Partners, their sign-ins and devices are entered by
// Velza Admin (a new device gets its batch codes on creation).

import { DEFAULT_SETTINGS, type User } from "@/lib/core/types";
import { generatePassword, hashPasswordSync } from "@/lib/passwords";
import type { DbSnapshot } from "./Store";

const id = () => crypto.randomUUID();

export const ADMIN_LOGIN_ID = "AD0001";
export const HQ_LOGIN_ID = "HQ0001";

export interface StaffPasswords {
  admin: string;
  hq: string;
}

/** Passwords from VELZA_ADMIN_PASSWORD / VELZA_HQ_PASSWORD, or new random ones (shown once by the caller). */
export function staffPasswords(): StaffPasswords {
  return { admin: process.env.VELZA_ADMIN_PASSWORD || generatePassword(), hq: process.env.VELZA_HQ_PASSWORD || generatePassword() };
}

export function buildBaseSeed(passwords: StaffPasswords = staffPasswords(), now = new Date()): DbSnapshot {
  const at = now.toISOString();
  const staff = (loginId: string, name: string, role: User["role"], password: string): User => ({
    id: loginId,
    name,
    role,
    partnerId: null,
    active: true,
    passwordHash: hashPasswordSync(password),
    passwordChangedAt: at,
    createdAt: at,
    lastLoginAt: null,
  });
  return {
    countries: [{ id: id(), code: "91", name: "India", active: true }],
    flavours: [
      { id: id(), code: "OR", name: "Original", active: true },
      { id: id(), code: "GA", name: "Green Apple", active: true },
      { id: id(), code: "NS", name: "No Sugar", active: true },
      { id: id(), code: "MN", name: "Mango", active: true },
    ],
    partners: [],
    users: [staff(ADMIN_LOGIN_ID, "Velza Admin", "ADMIN", passwords.admin), staff(HQ_LOGIN_ID, "Velza HQ", "TRACE_OWNER", passwords.hq)],
    devices: [],
    batchCodePool: [],
    batches: [],
    printOrders: [],
    lots: [],
    packs: [],
    movements: [],
    scans: [],
    reprints: [],
    sessions: [],
    // AD0001 and HQ0001 are taken; the next staff sign-ins are AD0002 / HQ0002.
    sequences: [
      { id: "AD", value: 1 },
      { id: "HQ", value: 1 },
    ],
    settings: [{ id: "default", ...DEFAULT_SETTINGS }],
  };
}

/** Seed for a first start without `npm run seed`: prints the two passwords once to the server log. */
export function firstRunSeed(where: string): DbSnapshot {
  const passwords = staffPasswords();
  console.log(
    `[velza] No data yet — created a clean start in ${where}.\n` +
      `[velza]   Velza Admin: sign-in ${ADMIN_LOGIN_ID}, password ${passwords.admin}\n` +
      `[velza]   Velza HQ:    sign-in ${HQ_LOGIN_ID}, password ${passwords.hq}\n` +
      `[velza] Change both after the first sign-in (Account page).`,
  );
  return buildBaseSeed(passwords);
}
