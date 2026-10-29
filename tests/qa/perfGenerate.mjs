// Performance dataset for the JSON store: N code records (stickers: case lots + their 4 packs) with partners,
// batches, movements and scans in the same shape the app writes. Starts from the QA data file (read only), so the
// QA sign-ins and passwords work; adds synthetic partners and stock. Fixed seed → the same file every time.
//
//   node tests/qa/perfGenerate.mjs --codes 100000 --out <file outside the repo>
//
// Shape per case lot: 1 lot + 4 packs, 3 factory movements (GENERATED, PRINTED, VERIFIED), plus DISPATCHED and
// RECEIVED for each hop it made, and 1 VERIFY scan. Status mix: 40% at the plant (PACKED), 20% at a Super
// Stockist, 20% at a Distributor, 15% at a Retailer, 5% in transit. RT0001 (QA-MH-2026-RTL-001) holds 1% of all
// lots so "My stock" has a realistic load.

import { readFileSync, writeFileSync } from "node:fs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const CODES = Number(arg("codes", "1000"));
const OUT = arg("out");
const TEMPLATE = arg("template", "data/qa-mh-2026.json");
if (!OUT) throw new Error("--out <file> is required (keep it outside the repo or in a git-ignored folder)");
if (/[\\/]db\.json$/.test(OUT) || OUT === TEMPLATE) throw new Error("Refusing to overwrite db.json or the QA data file");

// Deterministic PRNG (mulberry32)
let seed = 20261028;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
let uid = 0;
const id = () => `perf-${(++uid).toString(16).padStart(12, "0")}`;

const db = JSON.parse(readFileSync(TEMPLATE, "utf8"));
const MF = "MF0001";
const OP = `${MF}-OP`;
const QC = `${MF}-QC`;
const device = db.devices[0]?.id ?? null;
const t0 = Date.parse("2026-09-01T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// Partners: one per 50 code records (10% distributors, 90% retailers), under the two QA Super Stockists.
const extra = Math.floor(CODES / 50);
const dbs = ["DB0001", "DB0002", "DB0003", "DB0004", "DB0005"];
const rts = Array.from({ length: 10 }, (_, i) => `RT${String(i + 1).padStart(4, "0")}`);
let dbSeq = 5;
let rtSeq = Math.max(14, ...db.partners.filter((p) => p.type === "RETAILER").map((p) => Number(p.id.slice(2))));
const states = ["Maharashtra"];
for (let i = 0; i < extra; i++) {
  const isDb = i % 10 === 0;
  const pid = isDb ? `DB${String(++dbSeq).padStart(4, "0")}` : `RT${String(++rtSeq).padStart(4, "0")}`;
  const parentId = isDb ? pick(["SS0001", "SS0002"]) : pick(dbs);
  db.partners.push({
    id: pid,
    type: isDb ? "DB" : "RETAILER",
    name: `PERF ${isDb ? "Distributor" : "Retailer"} ${pid}`,
    place: "Perf",
    address: "Synthetic performance record",
    city: "Pune",
    state: pick(states),
    pincode: "411001",
    contactPerson: "Perf Contact",
    phone: `+91 00001 ${String(i).padStart(6, "0")}`,
    email: "",
    parentId,
    active: true,
    createdAt: iso(t0),
    createdBy: "AD0001",
  });
  (isDb ? dbs : rts).push(pid);
}
db.sequences = db.sequences.map((s) => (s.id === "DB" ? { ...s, value: dbSeq } : s.id === "RT" ? { ...s, value: rtSeq } : s));

// Batches and lots
const LOTS = Math.max(1, Math.floor(CODES / 5));
const flavours = ["OR", "GA", "NS", "MN"];
const usedBatch = new Set(db.batches.map((b) => b.code));
const batchCode = () => {
  let c;
  do c = Array.from({ length: 6 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(rnd() * 36)]).join("");
  while (usedBatch.has(c));
  usedBatch.add(c);
  return c;
};
let batch = null;
let lotInBatch = 0;
const mv = (type, code, fromId, toId, fromStatus, toStatus, userId, at, invoice = null) =>
  db.movements.push({ type, itemKind: "LOT", itemCode: code, fromId, toId, fromStatus, toStatus, userId, deviceId: userId === OP || userId === QC ? device : null, invoice, note: null, id: id(), at: iso(at) });

for (let i = 0; i < LOTS; i++) {
  if (!batch || lotInBatch === 100) {
    const flavour = pick(flavours);
    batch = { id: id(), code: batchCode(), country: "91", flavour, mfgDate: "2026-09-01", expiryDate: "2027-09-01", manufacturerId: MF, deviceId: device, nextLot: 1, status: "ACTIVE", synced: true, printOrderId: null, createdAt: iso(t0 + i * 60_000), createdBy: OP, recalledAt: null, recallReason: null };
    db.batches.push(batch);
    lotInBatch = 0;
  }
  lotInBatch += 1;
  batch.nextLot = lotInBatch + 1;
  const hex = lotInBatch.toString(16).toUpperCase().padStart(5, "0");
  const code = `91${batch.code}${batch.flavour}${hex}`;
  const at = t0 + i * 60_000;
  // Where it is now
  const r = rnd();
  let status = "PACKED";
  let loc = MF;
  let inTransitTo = null;
  const hops = [];
  const ss = pick(["SS0001", "SS0002"]);
  const dist = pick(dbs);
  const rt = i % 100 === 0 ? "RT0001" : pick(rts);
  // Below 0.4: stays at the plant (PACKED). Every 100th lot goes to RT0001.
  if (i % 100 === 0) {
    hops.push([MF, ss], [ss, dist], [dist, rt]);
    status = "AT_RETAILER";
    loc = rt;
  } else if (r >= 0.95) {
    status = "IN_TRANSIT";
    loc = MF;
    inTransitTo = ss;
  } else if (r >= 0.8) {
    hops.push([MF, ss], [ss, dist], [dist, rt]);
    status = "AT_RETAILER";
    loc = rt;
  } else if (r >= 0.6) {
    hops.push([MF, ss], [ss, dist]);
    status = "AT_DB";
    loc = dist;
  } else if (r >= 0.4) {
    hops.push([MF, ss]);
    status = "AT_SS";
    loc = ss;
  }
  db.lots.push({
    id: code, lotCode: code, batchCode: batch.code, flavour: batch.flavour, lotType: "CASE", packSize: 6, lotNumber: lotInBatch, status, locationId: loc,
    inTransitToId: inTransitTo, dispatchedAt: inTransitTo ? iso(at + 3600_000) : null, printOrderId: null, manufacturerId: MF, deviceId: device, synced: true,
    quarantineReason: null, statusBeforeRecall: null, createdAt: iso(at), updatedAt: iso(at + 7200_000),
  });
  for (let s = 1; s <= 4; s++) {
    const pc = `${code}6${s}`;
    db.packs.push({ id: pc, packCode: pc, lotCode: code, seq: s, packSize: 6, status, locationId: loc, inTransitToId: inTransitTo, dispatchedAt: inTransitTo ? iso(at + 3600_000) : null, statusBeforeRecall: null, createdAt: iso(at), updatedAt: iso(at + 7200_000) });
  }
  mv("GENERATED", code, null, MF, null, "GENERATED", OP, at);
  mv("PRINTED", code, MF, MF, "GENERATED", "PRINTED", OP, at + 60_000);
  mv("VERIFIED", code, MF, MF, "PRINTED", "PACKED", QC, at + 120_000);
  const tierStatus = (p) => (p.startsWith("SS") ? "AT_SS" : p.startsWith("DB") ? "AT_DB" : "AT_RETAILER");
  let prev = "PACKED";
  hops.forEach(([from, to], h) => {
    const t = at + (h + 1) * 3600_000;
    mv("DISPATCHED", code, from, to, prev, "IN_TRANSIT", from === MF ? OP : from, t, `PERF-${i}-${h}`);
    mv("RECEIVED", code, from, to, "IN_TRANSIT", tierStatus(to), to, t + 1800_000, `PERF-${i}-${h}`);
    prev = tierStatus(to);
  });
  if (inTransitTo) mv("DISPATCHED", code, MF, inTransitTo, "PACKED", "IN_TRANSIT", OP, at + 3600_000, `PERF-${i}`);
  db.scans.push({ context: "VERIFY", code, ok: true, result: "OK", message: `${code} verified`, userId: QC, partnerId: MF, deviceId: device, id: id(), at: iso(at + 120_000) });
}

writeFileSync(OUT, JSON.stringify(db));
const n = (k) => db[k].length;
console.log(JSON.stringify({ out: OUT, codeRecords: n("lots") + n("packs"), lots: n("lots"), packs: n("packs"), partners: n("partners"), batches: n("batches"), movements: n("movements"), scans: n("scans") }));
