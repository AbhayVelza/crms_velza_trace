// Test-only sample network on top of the clean base seed: the partners and people the demo script
// (spec 9.1) talks about, registered the way Velza Admin would (IDs in sequence, one sign-in each,
// two at the plant). Every sign-in has the password SAMPLE_PASSWORD. Never used by the app itself.

import { generateBatchCode } from "@/lib/core/codes";
import { formatSequenceId, PARTNER_ID_PREFIX, PARTNER_LOGIN_ROLES, partnerLoginId } from "@/lib/core/ids";
import { DEFAULT_SETTINGS, type BatchCodePoolEntry, type Partner, type PartnerType, type Role, type User } from "@/lib/core/types";
import { hashPasswordSync } from "@/lib/passwords";
import type { DbSnapshot } from "@/lib/store";
import { buildBaseSeed } from "@/lib/store/seedData";

export const SAMPLE_PASSWORD = "Sample2026pass";

const id = () => crypto.randomUUID();

const PARTNERS: { type: PartnerType; name: string; place: string; city: string; state: string; parent?: string }[] = [
  { type: "MANUFACTURER", name: "Demo Manufacturer – Pune", place: "Chakan MIDC", city: "Pune", state: "Maharashtra" },
  { type: "SS", name: "SS-1 Konkan Super Stockist", place: "Andheri East", city: "Mumbai", state: "Maharashtra" },
  { type: "SS", name: "SS-2 Deccan Super Stockist", place: "Koramangala", city: "Bengaluru", state: "Karnataka" },
  { type: "DB", name: "DB-1 Thane Distributors", place: "Wagle Estate", city: "Thane", state: "Maharashtra", parent: "SS-1" },
  { type: "DB", name: "DB-2 Kothrud Distributors", place: "Kothrud", city: "Pune", state: "Maharashtra", parent: "SS-2" },
  { type: "RETAILER", name: "Retailer-1 Bandra Fresh Mart", place: "Bandra", city: "Mumbai", state: "Maharashtra", parent: "DB-1" },
  { type: "RETAILER", name: "Retailer-2 Powai Corner Store", place: "Powai", city: "Mumbai", state: "Maharashtra", parent: "DB-1" },
  { type: "RETAILER", name: "Retailer-3 Aundh Cafe", place: "Aundh", city: "Pune", state: "Maharashtra", parent: "DB-2" },
  // One of the few retailers its Super Stockist supplies directly (no Distributor in between).
  { type: "RETAILER", name: "Retailer-4 Colaba Kirana", place: "Colaba", city: "Mumbai", state: "Maharashtra", parent: "SS-1" },
];

const PERSON: Partial<Record<Role, string>> = { OPERATOR: "Manoj", QC: "Sunita", SS: "Kiran", DB: "Deepak", RETAILER: "Imran" };

/** "SS-1", "Retailer-2", or the city for the manufacturer. */
const tag = (p: Pick<Partner, "name" | "city">) => p.name.match(/^([A-Za-z]+-\d+)/)?.[1] ?? p.city;

export function buildSampleSeed(): DbSnapshot {
  const base = buildBaseSeed({ admin: SAMPLE_PASSWORD, hq: SAMPLE_PASSWORD });
  const at = new Date().toISOString();
  const passwordHash = hashPasswordSync(SAMPLE_PASSWORD);
  const counters = new Map<string, number>();
  const partners: Partner[] = PARTNERS.map(({ type, name, place, city, state }, i) => {
    const prefix = PARTNER_ID_PREFIX[type];
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return {
      id: formatSequenceId(prefix, n),
      type,
      name,
      place,
      address: `${i + 1} Main Road, ${place}`,
      city,
      state,
      pincode: "",
      contactPerson: `${PERSON[PARTNER_LOGIN_ROLES[type][0]]} (${tag({ name, city })})`,
      phone: `+91 98000 ${String(10000 + i).slice(1)}`,
      email: "",
      parentId: null,
      active: true,
      createdAt: at,
      createdBy: "AD0001",
    };
  });
  for (const [i, p] of PARTNERS.entries()) if (p.parent) partners[i].parentId = partners.find((x) => x.name.startsWith(p.parent!))!.id;

  const users: User[] = [...base.users];
  for (const p of partners) {
    for (const role of PARTNER_LOGIN_ROLES[p.type]) {
      users.push({
        id: partnerLoginId(role, p.id),
        name: `${PERSON[role]} (${tag(p)})`,
        role,
        partnerId: p.id,
        active: true,
        passwordHash,
        passwordChangedAt: at,
        createdAt: at,
        lastLoginAt: null,
      });
    }
  }

  const device = { id: id(), manufacturerId: partners[0].id, name: "Pune Line-1 PC", offline: false, lastSyncAt: at };
  const taken = new Set<string>();
  const batchCodePool: BatchCodePoolEntry[] = Array.from({ length: DEFAULT_SETTINGS.poolIssueSize }, () => {
    const code = generateBatchCode(taken);
    taken.add(code);
    return { id: id(), code, deviceId: device.id, status: "RESERVED", issuedAt: at, usedAt: null };
  });

  return {
    ...base,
    partners,
    users,
    devices: [device],
    batchCodePool,
    sequences: [...base.sequences, ...[...counters].map(([prefix, value]) => ({ id: prefix, value }))],
  };
}
