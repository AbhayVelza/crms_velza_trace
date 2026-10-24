// Base seed (section 8): reference data, partners, one user per role per partner,
// one device with 10 reserved batch codes, default settings.

import { generateBatchCode } from "@/lib/core/codes";
import {
  DEFAULT_SETTINGS,
  type BatchCodePoolEntry,
  type Partner,
  type PartnerType,
  type Role,
  type User,
} from "@/lib/core/types";
import type { DbSnapshot } from "./Store";

const id = () => crypto.randomUUID();

const PARTNERS: { type: PartnerType; name: string; city: string }[] = [
  { type: "MANUFACTURER", name: "Demo Manufacturer – Pune", city: "Pune" },
  { type: "SS", name: "SS-1 Konkan Super Stockist", city: "Mumbai" },
  { type: "SS", name: "SS-2 Deccan Super Stockist", city: "Nashik" },
  { type: "DB", name: "DB-1 Thane Distributors", city: "Thane" },
  { type: "DB", name: "DB-2 Kothrud Distributors", city: "Pune" },
  { type: "SUPPLIER", name: "Supplier-1 Andheri Traders", city: "Mumbai" },
  { type: "SUPPLIER", name: "Supplier-2 Baner Traders", city: "Pune" },
  { type: "OUTLET", name: "Outlet-1 Bandra Fresh Mart", city: "Mumbai" },
  { type: "OUTLET", name: "Outlet-2 Powai Corner Store", city: "Mumbai" },
  { type: "OUTLET", name: "Outlet-3 Aundh Cafe", city: "Pune" },
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

export function buildBaseSeed(now = new Date()): DbSnapshot {
  const at = now.toISOString();
  const partners: Partner[] = PARTNERS.map((p) => ({ id: id(), active: true, ...p }));
  const manufacturer = partners[0];

  const users: User[] = [
    { id: id(), name: "Asha (Velza Admin)", role: "ADMIN", partnerId: null, active: true },
    { id: id(), name: "Ravi (Traceability Owner)", role: "TRACE_OWNER", partnerId: null, active: true },
  ];
  for (const p of partners) {
    for (const role of PARTNER_ROLES[p.type]) {
      users.push({ id: id(), name: `${ROLE_PERSON[role]} (${partnerTag(p)})`, role, partnerId: p.id, active: true });
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
    settings: [{ id: "default", ...DEFAULT_SETTINGS }],
  };
}
