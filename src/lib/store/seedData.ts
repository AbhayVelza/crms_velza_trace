// Base seed (section 8): reference data, partners, one user per role per partner,
// one device with 10 reserved batch codes, default settings.
// Every seeded account has a sign-in ID and the default password (SEED_PASSWORD), already approved.

import { generateBatchCode } from "@/lib/core/codes";
import {
  DEFAULT_SETTINGS,
  type BatchCodePoolEntry,
  type Partner,
  type PartnerType,
  type Role,
  type User,
} from "@/lib/core/types";
import { hashPasswordSync } from "@/lib/passwords";
import type { DbSnapshot } from "./Store";

const id = () => crypto.randomUUID();

/** Default password of every seeded account (override with env SEED_PASSWORD). */
export const DEFAULT_SEED_PASSWORD = "Velza@2026";

const PARTNERS: { type: PartnerType; name: string; city: string; territory: string; parent?: string }[] = [
  { type: "MANUFACTURER", name: "Demo Manufacturer – Pune", city: "Pune", territory: "" },
  { type: "SS", name: "SS-1 Konkan Super Stockist", city: "Mumbai", territory: "North & West Maharashtra" },
  { type: "SS", name: "SS-2 Deccan Super Stockist", city: "Pune", territory: "East & South Maharashtra" },
  { type: "DB", name: "DB-1 Thane Distributors", city: "Thane", territory: "Thane district", parent: "SS-1" },
  { type: "DB", name: "DB-2 Kothrud Distributors", city: "Pune", territory: "Pune city", parent: "SS-2" },
  { type: "SUPPLIER", name: "Supplier-1 Andheri Traders", city: "Mumbai", territory: "" },
  { type: "SUPPLIER", name: "Supplier-2 Baner Traders", city: "Pune", territory: "" },
  { type: "OUTLET", name: "Outlet-1 Bandra Fresh Mart", city: "Mumbai", territory: "" },
  { type: "OUTLET", name: "Outlet-2 Powai Corner Store", city: "Mumbai", territory: "" },
  { type: "OUTLET", name: "Outlet-3 Aundh Cafe", city: "Pune", territory: "" },
];

const PARTNER_ROLES: Record<PartnerType, Role[]> = {
  MANUFACTURER: ["OPERATOR", "QC"],
  SS: ["SS"],
  DB: ["DB"],
  SUPPLIER: ["SUPPLIER"],
  OUTLET: ["OUTLET"],
};

const ROLE_PERSON: Record<Role, string> = {
  ADMIN: "Asha",
  OPERATOR: "Manoj",
  QC: "Sunita",
  SS: "Kiran",
  DB: "Deepak",
  SUPPLIER: "Farah",
  OUTLET: "Imran",
  TRACE_OWNER: "Ravi",
};

/** Short partner tag used in user names: "SS-1", "Outlet-2", "Pune". */
export function partnerTag(p: Pick<Partner, "name" | "city" | "type">): string {
  const m = p.name.match(/^([A-Za-z]+-\d+)/);
  return m ? m[1] : p.city;
}

/** Seeded sign-in IDs: admin, hq, operator, qc, ss1, db2, supplier1, outlet3, … */
export function seedLoginId(role: Role, p: Pick<Partner, "name" | "city" | "type"> | null): string {
  if (role === "ADMIN") return "admin";
  if (role === "TRACE_OWNER") return "hq";
  if (role === "OPERATOR") return "operator";
  if (role === "QC") return "qc";
  return partnerTag(p!).replace("-", "").toLowerCase();
}

export function buildBaseSeed(now = new Date(), password = process.env.SEED_PASSWORD || DEFAULT_SEED_PASSWORD): DbSnapshot {
  const at = now.toISOString();
  const partners: Partner[] = PARTNERS.map(({ type, name, city, territory }) => ({ id: id(), type, name, city, territory, parentId: null, active: true }));
  for (const [i, p] of PARTNERS.entries()) {
    if (p.parent) partners[i].parentId = partners.find((x) => x.name.startsWith(p.parent!))!.id;
  }
  const manufacturer = partners[0];

  // One hash shared by the seeded accounts: they all start with the same documented password.
  const passwordHash = hashPasswordSync(password);
  const account = (name: string, role: Role, partner: Partner | null): User => ({
    id: id(),
    name,
    role,
    partnerId: partner?.id ?? null,
    active: true,
    loginId: seedLoginId(role, partner),
    passwordHash,
    createdAt: at,
    adminApprovedBy: null,
    adminApprovedAt: null,
    hqApprovedBy: null,
    hqApprovedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectReason: null,
  });

  const admin = account("Asha (Velza Admin)", "ADMIN", null);
  const hq = account("Ravi (Velza HQ)", "TRACE_OWNER", null);
  const users: User[] = [admin, hq];
  for (const p of partners) {
    for (const role of PARTNER_ROLES[p.type]) {
      users.push({
        ...account(`${ROLE_PERSON[role]} (${partnerTag(p)})`, role, p),
        adminApprovedBy: admin.id,
        adminApprovedAt: at,
        hqApprovedBy: hq.id,
        hqApprovedAt: at,
      });
    }
  }

  const device = { id: id(), manufacturerId: manufacturer.id, name: "Pune Line-1 PC", offline: false, lastSyncAt: at };

  const taken = new Set<string>();
  const batchCodePool: BatchCodePoolEntry[] = Array.from({ length: DEFAULT_SETTINGS.poolIssueSize }, () => {
    const code = generateBatchCode(taken);
    taken.add(code);
    return { id: id(), code, deviceId: device.id, status: "RESERVED", issuedAt: at, usedAt: null };
  });

  return {
    countries: [{ id: id(), code: "91", name: "India", active: true }],
    flavours: [
      { id: id(), code: "OR", name: "Original", active: true },
      { id: id(), code: "GA", name: "Green Apple", active: true },
      { id: id(), code: "NS", name: "No Sugar", active: true },
      { id: id(), code: "MN", name: "Mango", active: true },
    ],
    partners,
    users,
    devices: [device],
    batchCodePool,
    batches: [],
    printOrders: [],
    lots: [],
    packs: [],
    movements: [],
    scans: [],
    reprints: [],
    sessions: [],
    settings: [{ id: "default", ...DEFAULT_SETTINGS }],
  };
}
