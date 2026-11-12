// Builds the management-demo data set through the real HTTP API of a running, isolated server (sign-in ON), and
// checks every step of the traceability lifecycle while doing it. Never touches data/db.json or port 3000.
//
//   DEMO_BASE=http://localhost:3400 DEMO_DB_PATH=<demo>/data/demo.json DEMO_CREDENTIALS=<demo>/demo-credentials.json \
//     npx tsx tests/qa/demoSetup.ts
//
// The credentials file (outside the repo) must hold { adminPassword, hqPassword, partnerPassword }; the server must
// have been started with VELZA_ADMIN_PASSWORD / VELZA_HQ_PASSWORD from it. Passwords are never printed.
// Idempotent for partners and devices (found by their DEMO- names); the stock story runs once, on a fresh file.
// Results: DEMO_EVIDENCE (default <demo>/evidence/demo-setup-results.json).

import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = process.env.DEMO_BASE ?? "http://localhost:3400";
const DB_PATH = path.resolve(process.env.DEMO_DB_PATH ?? "");
const CREDS_PATH = path.resolve(process.env.DEMO_CREDENTIALS ?? "");
const EVIDENCE = path.resolve(process.env.DEMO_EVIDENCE ?? path.join(path.dirname(DB_PATH), "..", "evidence", "demo-setup-results.json"));

if (!process.env.DEMO_DB_PATH || !process.env.DEMO_CREDENTIALS) throw new Error("Set DEMO_DB_PATH and DEMO_CREDENTIALS");
if (path.basename(DB_PATH) === "db.json") throw new Error("Refusing to build demo data in a db.json file");
if (/:3000\b/.test(BASE)) throw new Error("Refusing to run against port 3000");

// ---------------------------------------------------------------- results

type Status = "PASS" | "FAIL";
const results: { id: string; step: string; check: string; status: Status; detail: string }[] = [];
function check(step: string, name: string, ok: boolean, detail = "") {
  const status: Status = ok ? "PASS" : "FAIL";
  results.push({ id: `DEMO-${String(results.length + 1).padStart(3, "0")}`, step, check: name, status, detail });
  console.log(`${status.padEnd(5)} ${step} · ${name}${ok ? "" : ` — ${detail}`}`);
}

// ---------------------------------------------------------------- HTTP with one cookie per person

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}
class Session {
  cookie = "";
  constructor(public who: string) {}
  async req(method: string, url: string, body?: unknown): Promise<Res> {
    const headers: Record<string, string> = { origin: BASE };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("set-cookie");
    const m = set && /velza_session=([^;]*)/.exec(set);
    if (m) this.cookie = m[1] ? `velza_session=${m[1]}` : "";
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed };
  }
  get = (url: string) => this.req("GET", url);
  post = (url: string, body: unknown) => this.req("POST", url, body);
  /** POST that must succeed (HTTP 200 and not `ok: false`). */
  async must(url: string, body: unknown, what: string) {
    const r = await this.post(url, body);
    if (r.status !== 200 || r.body?.ok === false) throw new Error(`${this.who}: ${what} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }
}
async function signIn(loginId: string, password: string): Promise<Session> {
  const s = new Session(loginId);
  const r = await s.post("/api/auth/login", { loginId, password });
  if (r.status !== 200) throw new Error(`Sign-in as ${loginId} failed: ${r.status}`);
  return s;
}

// ---------------------------------------------------------------- the demo network

interface DemoPartner {
  key: string;
  type: "MANUFACTURER" | "SS" | "DB" | "RETAILER";
  parent: string | null;
  name: string;
  place: string;
  city: string;
  pincode: string;
  contactPerson: string;
  phone: string;
  email: string;
}
const NETWORK: DemoPartner[] = [
  { key: "MF", type: "MANUFACTURER", parent: null, name: "DEMO-Manufacturer Velza Beverages Plant", place: "Chakan MIDC", city: "Pune", pincode: "410501", contactPerson: "Demo Plant Manager", phone: "+91 00000 300001", email: "demo-plant@example.com" },
  { key: "SS", type: "SS", parent: null, name: "DEMO-SuperStockist Maharashtra", place: "Bhosari", city: "Pune", pincode: "411026", contactPerson: "Demo SS Manager", phone: "+91 00000 300002", email: "demo-ss@example.com" },
  { key: "DB1", type: "DB", parent: "SS", name: "DEMO-Distributor Mumbai", place: "Andheri East", city: "Mumbai", pincode: "400069", contactPerson: "Demo Distributor One", phone: "+91 00000 300003", email: "demo-db1@example.com" },
  { key: "DB2", type: "DB", parent: "SS", name: "DEMO-Distributor Nashik", place: "Satpur", city: "Nashik", pincode: "422007", contactPerson: "Demo Distributor Two", phone: "+91 00000 300004", email: "demo-db2@example.com" },
  { key: "RT1", type: "RETAILER", parent: "DB1", name: "DEMO-Retailer Andheri Mart", place: "Andheri West", city: "Mumbai", pincode: "400058", contactPerson: "Demo Retailer One", phone: "+91 00000 300005", email: "demo-rt1@example.com" },
  { key: "RT2", type: "RETAILER", parent: "DB2", name: "DEMO-Retailer Nashik Fresh", place: "College Road", city: "Nashik", pincode: "422005", contactPerson: "Demo Retailer Two", phone: "+91 00000 300006", email: "demo-rt2@example.com" },
  { key: "RT3", type: "RETAILER", parent: "SS", name: "DEMO-Retailer Pune Direct", place: "Kothrud", city: "Pune", pincode: "411038", contactPerson: "Demo Retailer Three", phone: "+91 00000 300007", email: "demo-rt3@example.com" },
];
const DEVICES = ["DEMO Plant PC-1 (Line 1)", "DEMO Plant PC-2 (Line 2)"];

const packsOf = (lot: string, type: "CASE" | "TRAY") => (type === "CASE" ? [1, 2, 3, 4].map((s) => `${lot}6${s}`) : [1, 2, 3, 4, 5, 6].map((s) => `${lot}4${s}`));

async function main() {
  const creds = JSON.parse(await fs.readFile(CREDS_PATH, "utf8")) as { adminPassword: string; hqPassword: string; partnerPassword: string };
  const mode = await new Session("anon").get("/api/auth/mode");
  check("0 Environment", "Server up with sign-in ON", mode.status === 200 && JSON.stringify(mode.body).includes("true"), JSON.stringify(mode.body));

  // ---------- 1. Admin builds the hierarchy (Partners → Register)
  const admin = await signIn("AD0001", creds.adminPassword);
  const ids: Record<string, string> = {};
  const logins: Record<string, string[]> = {};
  const existing = (await admin.get("/api/admin/partners")).body as { id: string; name: string; parentId: string | null; type: string }[];
  for (const p of NETWORK) {
    const found = existing.find((e) => e.name === p.name);
    if (found) {
      ids[p.key] = found.id;
      continue;
    }
    const { key, parent, ...fields } = p;
    const r = await admin.must("/api/admin/partners", { ...fields, state: "Maharashtra", address: `${p.place}, ${p.city}`, parentId: parent ? ids[parent] : null, password: creds.partnerPassword, qcPassword: creds.partnerPassword }, `register ${p.name}`);
    ids[key] = r.partner.id;
    logins[key] = r.logins.map((l: { id: string }) => l.id);
  }
  check("1 Admin: hierarchy", "7 DEMO partners registered", Object.keys(ids).length === 7, JSON.stringify(ids));
  const partners = (await admin.get("/api/admin/partners")).body as { id: string; parentId: string | null }[];
  const parentOf = (k: string) => partners.find((p) => p.id === ids[k])?.parentId ?? null;
  check("1 Admin: hierarchy", "Distributors under the SS; RT1→DB1, RT2→DB2, RT3 directly under the SS", parentOf("DB1") === ids.SS && parentOf("DB2") === ids.SS && parentOf("RT1") === ids.DB1 && parentOf("RT2") === ids.DB2 && parentOf("RT3") === ids.SS);
  if (logins.MF) check("1 Admin: hierarchy", "Plant gets its Operator and QC sign-ins", logins.MF.includes(`${ids.MF}-OP`) && logins.MF.includes(`${ids.MF}-QC`), logins.MF.join(","));
  const dupe = await admin.post("/api/admin/partners", { ...NETWORK[2], name: "DEMO-duplicate phone", state: "Maharashtra", address: "x", parentId: ids.SS, password: creds.partnerPassword });
  check("1 Admin: hierarchy", "Duplicate phone number refused", dupe.status === 400, `${dupe.status}`);

  // ---------- 2. Admin registers the plant's two PCs (Devices)
  let devices = ((await admin.get("/api/admin/devices")).body as { id: string; name: string; manufacturerId: string }[]).filter((d) => d.manufacturerId === ids.MF);
  for (const name of DEVICES) if (!devices.some((d) => d.name === name)) await admin.must("/api/admin/devices", { manufacturerId: ids.MF, name }, `device ${name}`);
  devices = ((await admin.get("/api/admin/devices")).body as { id: string; name: string; manufacturerId: string }[]).filter((d) => d.manufacturerId === ids.MF);
  const pc1 = devices.find((d) => d.name === DEVICES[0])!.id;
  const pc2 = devices.find((d) => d.name === DEVICES[1])!.id;
  check("2 Admin: devices", "Two plant PCs registered", !!pc1 && !!pc2 && devices.length >= 2, devices.map((d) => d.name).join(" | "));

  const already = await signIn(`${ids.MF}-OP`, creds.partnerPassword);
  const orders = (await already.get("/api/print-orders")).body as unknown[];
  if (orders.length) {
    check("3 Stock story", "Already built on this data file (rerun: partners and devices only)", true);
    return finish();
  }

  // ---------- 3. Operator: batch A (Original), 4 cases + 2 trays, printed and confirmed
  const op = already;
  const today = new Date().toISOString().slice(0, 10);
  const expiry = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  const a = await op.must("/api/print-orders", { idempotencyKey: crypto.randomUUID(), deviceId: pc1, batches: [{ flavour: "OR", mfgDate: today, expiryDate: expiry, cases: 4, trays: 2 }] }, "print order A");
  const orderA = a.printOrder as { id: string; lotCodes: string[]; batchCodes: string[]; stickerCount: number; status: string };
  check("3 Operator: print order A", "Batch A (Original): 6 lots, 4×5 + 2×7 = 34 stickers, status CREATED", orderA.lotCodes.length === 6 && orderA.stickerCount === 34 && orderA.status === "CREATED", `${orderA.lotCodes.length} lots, ${orderA.stickerCount} stickers`);
  const view = await op.get(`/api/print-orders/${orderA.id}`);
  const codes = await op.get(`/api/print-orders/${orderA.id}/codes`);
  check("3 Operator: print order A", "Opening the print view and the codes list (CSV source) leaves it CREATED", view.body.printOrder.status === "CREATED" && codes.body.totals.stickers === 34 && (await op.get(`/api/print-orders/${orderA.id}`)).body.printOrder.status === "CREATED");
  const qc = await signIn(`${ids.MF}-QC`, creds.partnerPassword);
  const early = await qc.post("/api/verify", { action: "scanLot", code: orderA.lotCodes[0] });
  check("4 QC", "Unprinted lot refused as NOT_PRINTED", early.body.code === "NOT_PRINTED", early.body.code);
  const mark = await op.must(`/api/print-orders/${orderA.id}/printed`, {}, "mark A printed");
  check("3 Operator: print order A", "Mark as printed → 6 lots PRINTED, order has printedAt", mark.lotsPrinted === 6 && !!mark.printOrder.printedAt);
  const again = await op.must(`/api/print-orders/${orderA.id}/printed`, {}, "mark A printed again");
  check("3 Operator: print order A", "Repeated confirmation changes nothing", again.lotsPrinted === 0);

  // ---------- 3b. Batch B (Green Apple), 2 cases + 1 tray, left PRINTING PENDING
  const b = await op.must("/api/print-orders", { idempotencyKey: crypto.randomUUID(), deviceId: pc1, batches: [{ flavour: "GA", mfgDate: today, expiryDate: expiry, cases: 2, trays: 1 }] }, "print order B");
  const orderB = b.printOrder as { id: string; lotCodes: string[]; batchCodes: string[] };
  check("3 Operator: print order B", "Batch B (Green Apple): 3 lots, pending print", orderB.lotCodes.length === 3 && b.printOrder.status === "CREATED");

  // ---------- 3c. Continue batch A on the second PC: 2 more cases, numbered after the first 6
  const cont = await op.must("/api/print-orders/continue", { batchCode: orderA.batchCodes[0], cases: 2, trays: 0, deviceId: pc2, idempotencyKey: crypto.randomUUID() }, "continue A on PC-2");
  const orderC = cont.printOrder as { id: string; lotCodes: string[] };
  check("3 Operator: continuation", "Batch A continued on PC-2 from lot 00007 (no reuse)", orderC.lotCodes.map((c) => c.slice(-5)).join(",") === "00007,00008", orderC.lotCodes.join(","));
  await op.must(`/api/print-orders/${orderC.id}/printed`, {}, "mark continuation printed");

  // ---------- 4. QC verifies; one case fails (a pack sticker missing) → QUARANTINED
  const type = (i: number) => (i < 4 ? "CASE" : "TRAY") as "CASE" | "TRAY";
  const lotsA = orderA.lotCodes;
  async function qcVerify(lot: string, t: "CASE" | "TRAY", packs = packsOf(lot, t)) {
    const s = await qc.post("/api/verify", { action: "scanLot", code: lot });
    if (s.body.ok !== true) throw new Error(`QC scan ${lot}: ${JSON.stringify(s.body)}`);
    for (const [i, p] of packs.entries()) await qc.must("/api/verify", { action: "scanPack", lotCode: lot, code: p, scanned: packs.slice(0, i) }, `scan pack ${p}`);
    return (await qc.post("/api/verify", { action: "confirm", lotCode: lot, packCodes: packs })).body;
  }
  const verified: string[] = [];
  for (const [i, lot] of lotsA.entries()) {
    if (i === 3) continue; // quarantined below
    const r = await qcVerify(lot, type(i));
    if (r.ok) verified.push(lot);
  }
  for (const lot of orderC.lotCodes) if ((await qcVerify(lot, "CASE")).ok) verified.push(lot);
  check("4 QC", "7 lots verified → PACKED (5 of batch A, 2 continued)", verified.length === 7, verified.join(","));
  const wrongPack = await qc.post("/api/verify", { action: "scanLot", code: lotsA[3] });
  const foreign = await qc.post("/api/verify", { action: "scanPack", lotCode: lotsA[3], code: `${lotsA[0]}61`, scanned: [] });
  check("4 QC", "A pack of another lot is refused (WRONG_LOT)", wrongPack.body.ok === true && foreign.body.code === "WRONG_LOT", foreign.body.code);
  const q = await qc.post("/api/verify", { action: "confirm", lotCode: lotsA[3], packCodes: packsOf(lotsA[3], "CASE").slice(0, 3) });
  check("4 QC", "Case with a missing pack sticker → QUARANTINED", q.body.code === "QUARANTINED", q.body.code);
  const blocked = await new Session("x").get("/api/stock");
  check("4 QC", "Anonymous API request refused", blocked.status === 401, `${blocked.status}`);

  // ---------- 5. Plant dispatches to the SS; the SS receives
  const [c1, c2, c3, , t1, t2] = lotsA;
  const [k1] = orderC.lotCodes;
  async function send(from: Session, to: string, invoice: string, lots: string[]) {
    for (const [i, code] of lots.entries()) await from.must("/api/dispatch", { action: "check", toPartnerId: to, invoice, code, listed: lots.slice(0, i) }, `check ${code}`);
    return from.must("/api/dispatch", { action: "confirm", toPartnerId: to, invoice, codes: lots }, `dispatch ${invoice}`);
  }
  await send(op, ids.SS, "DEMO-INV-001", [c1, c2, c3, t1, t2, k1]);
  const ss = await signIn(ids.SS, creds.partnerPassword);
  const db1 = await signIn(ids.DB1, creds.partnerPassword);
  const misdirected = await db1.post("/api/receive", { code: c1 });
  check("5 Dispatch / receipt", "Distributor cannot receive stock sent to the SS (WRONG_RECEIVER alert)", misdirected.body.code === "WRONG_RECEIVER", misdirected.body.code);
  for (const code of [c1, c2, c3, t1, t2, k1]) await ss.must("/api/receive", { code }, `SS receive ${code}`);
  const ssStock = (await ss.get("/api/stock")).body;
  check("5 Dispatch / receipt", "SS stock after receipt: 4 cases, 2 trays", JSON.stringify(ssStock).includes(c1) && JSON.stringify(ssStock).includes(t2), "");
  const quarantinedDispatch = await op.post("/api/dispatch", { action: "check", toPartnerId: ids.SS, invoice: "DEMO-INV-X", code: lotsA[3] });
  check("5 Dispatch / receipt", "Quarantined case cannot be dispatched", quarantinedDispatch.body.ok === false, quarantinedDispatch.body.code);

  // ---------- 6. SS → DB1 → RT1 (opens); SS → DB2 → RT2; SS → RT3 directly; one tray left in transit
  await send(ss, ids.DB1, "DEMO-INV-101", [c1, c2]);
  for (const code of [c1, c2]) await db1.must("/api/receive", { code }, `DB1 receive ${code}`);
  await send(db1, ids.RT1, "DEMO-INV-201", [c1]);
  const rt1 = await signIn(ids.RT1, creds.partnerPassword);
  await rt1.must("/api/receive", { code: c1 }, "RT1 receive");
  const opened = await rt1.must("/api/open-lot", { lotCode: c1 }, "RT1 open");
  check("6 Chain", "Retailer (via SS → DB) receives and opens a case", opened.ok !== false);

  const db2 = await signIn(ids.DB2, creds.partnerPassword);
  await send(ss, ids.DB2, "DEMO-INV-102", [t1, t2]);
  await db2.must("/api/receive", { code: t1 }, "DB2 receive t1"); // t2 stays in transit to DB2
  const rt2 = await signIn(ids.RT2, creds.partnerPassword);
  await send(db2, ids.RT2, "DEMO-INV-202", [t1]);
  await rt2.must("/api/receive", { code: t1 }, "RT2 receive");

  await send(ss, ids.RT3, "DEMO-INV-103", [c3]);
  const rt3 = await signIn(ids.RT3, creds.partnerPassword);
  await rt3.must("/api/receive", { code: c3 }, "RT3 receive (direct)");
  check("6 Chain", "Direct SS → Retailer delivery received", true);
  const wrongTier = await ss.post("/api/dispatch", { action: "check", toPartnerId: ids.RT1, invoice: "DEMO-INV-X", code: k1 });
  check("6 Chain", "SS cannot dispatch to another distributor's retailer", wrongTier.body.ok === false, wrongTier.body.code);
  const rt1Sees = JSON.stringify((await rt1.get("/api/stock")).body);
  check("6 Chain", "Retailer 1 does not see Retailer 3's stock", rt1Sees.includes(c1) && !rt1Sees.includes(c3));

  // ---------- 7. HQ traces the opened case end to end
  const hq = await signIn("HQ0001", creds.hqPassword);
  const look = (await hq.get(`/api/lookup/${c1}`)).body;
  const events = (look.timeline ?? []).map((t: { event: string }) => t.event);
  check("7 HQ trace", "Opened case timeline: generated → printed → verified → 3 hand-overs → opened", ["GENERATED", "PRINTED", "VERIFIED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "OPENED"].every((e) => events.includes(e)), events.join(","));
  const packLook = (await hq.get(`/api/lookup/${c1}62`)).body;
  check("7 HQ trace", "A pack of the opened case resolves to its case and retailer", JSON.stringify(packLook).includes(c1), "");
  const alerts = JSON.stringify((await hq.get("/api/alerts")).body);
  check("7 HQ trace", "Wrong-receiver attempt raised an HQ alert", alerts.includes("WRONG_RECEIVER"));
  const dash = await hq.get("/api/dashboard");
  check("7 HQ trace", "HQ dashboard answers", dash.status === 200);
  const dbFile = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  check("8 Integrity", "No duplicate lot codes", new Set(dbFile.lots.map((l: { lotCode: string }) => l.lotCode)).size === dbFile.lots.length);
  check("8 Integrity", "Every pack belongs to an existing lot", dbFile.packs.every((p: { lotCode: string }) => dbFile.lots.some((l: { lotCode: string }) => l.lotCode === p.lotCode)));
  check("8 Integrity", "Batch B still pending print (GENERATED, order CREATED)", orderB.lotCodes.every((c) => dbFile.lots.find((l: { lotCode: string }) => l.lotCode === c)?.status === "GENERATED"));
  return finish();
}

async function finish() {
  await fs.mkdir(path.dirname(EVIDENCE), { recursive: true });
  await fs.writeFile(EVIDENCE, JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} checks passed → ${EVIDENCE}`);
  if (failed) process.exitCode = 1;
}

main().catch(async (e) => {
  check("Run", "Completed without an unexpected error", false, String(e?.message ?? e));
  await finish();
  process.exitCode = 1;
});
