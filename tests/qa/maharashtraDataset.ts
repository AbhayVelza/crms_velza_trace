// QA dataset: 18 synthetic partners in Maharashtra (1 Manufacturer, 2 Super Stockists, 5 Distributors,
// 10 Retailers). Shared by the live QA run (tests/qa/qaRun.ts) and the unit test
// (tests/unit/maharashtraDataset.test.ts).
//
// Real rules this dataset follows (src/lib/services/admin.ts):
// - Partner IDs are issued by the app (MF0001, SS0001 …); the QA code (QA-MH-2026-…) is the start of the name,
//   which is how a rerun finds the records again.
// - One Super Stockist per state: a second Maharashtra SS is refused (STATE_TAKEN). SS-002 is therefore in
//   Goa (Panaji), next to the Kolhapur and Solapur distributors it supplies. Every other record is in Maharashtra.
// - Phones and emails must be unique: phones are "+91 00000 2026NN" (not dialable), emails @example.com.
// - A Distributor is assigned to a Super Stockist; a Retailer to a Distributor (or an SS). The Manufacturer and
//   Super Stockists have no parent: any plant can supply any SS.

export const QA_PREFIX = "QA-MH-2026";

export type QaTier = "MANUFACTURER" | "SS" | "DB" | "RETAILER";

export interface QaPartner {
  /** QA code, e.g. QA-MH-2026-DST-001; the partner's name starts with it. */
  code: string;
  type: QaTier;
  /** QA code of the parent (resolved to the real partner ID at creation). */
  parent: string | null;
  name: string;
  place: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  contactPerson: string;
  phone: string;
  email: string;
}

const p = (n: number) => String(n).padStart(2, "0");
let seq = 0;
function partner(code: string, type: QaTier, parent: string | null, title: string, place: string, city: string, pincode: string, state = "Maharashtra"): QaPartner {
  seq += 1;
  const slug = code.toLowerCase();
  return {
    code,
    type,
    parent,
    name: `${code} ${title}`,
    place,
    address: `QA test address ${p(seq)}, ${place}`,
    city,
    state,
    pincode,
    contactPerson: `QA Contact ${code.slice(QA_PREFIX.length + 1)}`,
    phone: `+91 00000 2026${p(seq)}`,
    email: `${slug}@example.com`,
  };
}

const MFG = `${QA_PREFIX}-MFG-001`;
const SS1 = `${QA_PREFIX}-SS-001`;
const SS2 = `${QA_PREFIX}-SS-002`;
const DST = (n: number) => `${QA_PREFIX}-DST-00${n}`;
const RTL = (n: number) => `${QA_PREFIX}-RTL-${String(n).padStart(3, "0")}`;

/** In creation order: parents always before their children. */
export const MAHARASHTRA_PARTNERS: QaPartner[] = [
  partner(MFG, "MANUFACTURER", null, "Sahyadri Beverages Plant", "Chakan MIDC", "Pune", "410501"),
  partner(SS1, "SS", null, "Deccan Super Stockist", "Hadapsar", "Pune", "411028"),
  partner(SS2, "SS", null, "Konkan Coast Super Stockist", "Panaji", "Panaji", "403001", "Goa"),
  partner(DST(1), "DB", SS1, "Shivajinagar Distributors", "Shivajinagar", "Pune", "411005"),
  partner(DST(2), "DB", SS1, "Nashik Valley Distributors", "College Road", "Nashik", "422005"),
  partner(DST(3), "DB", SS1, "Andheri Distributors", "Andheri East", "Mumbai", "400069"),
  partner(DST(4), "DB", SS2, "Kolhapur Distributors", "Shahupuri", "Kolhapur", "416001"),
  partner(DST(5), "DB", SS2, "Solapur Distributors", "Navi Peth", "Solapur", "413001"),
  partner(RTL(1), "RETAILER", DST(1), "Kothrud Fresh Mart", "Kothrud", "Pune", "411038"),
  partner(RTL(2), "RETAILER", DST(1), "Baner Kirana", "Baner", "Pune", "411045"),
  partner(RTL(3), "RETAILER", DST(2), "Gangapur Road Store", "Gangapur Road", "Nashik", "422013"),
  partner(RTL(4), "RETAILER", DST(2), "Nashik Road Mart", "Nashik Road", "Nashik", "422101"),
  partner(RTL(5), "RETAILER", DST(3), "Powai Corner Store", "Powai", "Mumbai", "400076"),
  partner(RTL(6), "RETAILER", DST(3), "Dadar Cafe", "Dadar", "Mumbai", "400014"),
  partner(RTL(7), "RETAILER", DST(4), "Rajarampuri Stores", "Rajarampuri", "Kolhapur", "416008"),
  partner(RTL(8), "RETAILER", DST(4), "Ichalkaranji Mart", "Ichalkaranji", "Kolhapur", "416115"),
  partner(RTL(9), "RETAILER", DST(5), "Hotgi Road Kirana", "Hotgi Road", "Solapur", "413003"),
  partner(RTL(10), "RETAILER", DST(5), "Pandharpur Fresh", "Pandharpur", "Solapur", "413304"),
];

export const EXPECTED_COUNTS: Record<QaTier, number> = { MANUFACTURER: 1, SS: 2, DB: 5, RETAILER: 10 };

/** Find a QA partner among the app's partners by its QA code (the start of the name). */
export function matchQaPartner<T extends { name: string }>(rows: T[], code: string): T[] {
  return rows.filter((r) => r.name === code || r.name.startsWith(`${code} `));
}
