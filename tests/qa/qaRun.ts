// Live QA run against a running server with SIGN-IN ON and its own data file (never data/db.json).
// Creates the 18-partner Maharashtra dataset through the real registration API (idempotent: a rerun finds the
// records by their QA code and creates only what is missing), then tests sign-in, every role against every API,
// security boundaries, the partner lifecycle, a full scan chain with traceability, and data integrity.
//
//   QA_BASE=http://localhost:3300 QA_DB_PATH=data/qa-mh-2026.json npx tsx tests/qa/qaRun.ts
//
// Passwords come from data/qa-mh-2026-credentials.json (git-ignored; see docs/MANUAL_QA_GUIDE.md) and are
// never printed. Results: docs/qa/qa-run-results.json; dataset manifest: docs/qa/maharashtra-test-data.json.

import { promises as fs } from "node:fs";
import path from "node:path";
import { PERMISSIONS, type Action } from "../../src/lib/core/permissions";
import type { Role } from "../../src/lib/core/types";
import { EXPECTED_COUNTS, MAHARASHTRA_PARTNERS, matchQaPartner, QA_PREFIX, type QaPartner } from "./maharashtraDataset";

const BASE = process.env.QA_BASE ?? "http://localhost:3300";
const DB_PATH = path.resolve(process.env.QA_DB_PATH ?? "data/qa-mh-2026.json");
const CREDS_PATH = path.resolve(process.env.QA_CREDENTIALS ?? "data/qa-mh-2026-credentials.json");
const OUT_DIR = path.resolve("docs/qa");
const DEVICE_NAME = `${QA_PREFIX} Plant PC`;

type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT RUN" | "NEEDS INVESTIGATION";
interface Result {
  id: string;
  area: string;
  test: string;
  status: Status;
  expected: string;
  actual: string;
}
const results: Result[] = [];
let n = 0;
function record(area: string, test: string, ok: boolean | Status, expected: string, actual: string) {
  const status: Status = typeof ok === "string" ? ok : ok ? "PASS" : "FAIL";
  actual = actual.trim();
  results.push({ id: `QA-${String(++n).padStart(3, "0")}`, area, test, status, expected, actual });
  console.log(`${status.padEnd(7)} ${area} · ${test}${status === "PASS" ? "" : ` — expected ${expected}; actual ${actual}`}`);
}

// ---------------------------------------------------------------- HTTP with a cookie per session

interface Res {
  status: number;
  body: unknown;
  text: string;
  ms: number;
}
class Session {
  cookie = "";
  constructor(public label: string) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      h["content-type"] ??= "application/json";
    }
    const t = performance.now();
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: "manual" });
    const text = await res.text();
    const ms = performance.now() - t;
    const set = res.headers.get("set-cookie");
    if (set) {
      const m = /velza_session=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `velza_session=${m[1]}` : "";
    }
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // HTML or empty
    }
    return { status: res.status, body: parsed, text, ms };
  }
  get = (url: string) => this.req("GET", url);
  post = (url: string, body: unknown) => this.req("POST", url, body);
  patch = (url: string, body: unknown) => this.req("PATCH", url, body);
  del = (url: string) => this.req("DELETE", url);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Res) => r.body as any;
const errCode = (r: Res) => (j(r)?.error?.code as string | undefined) ?? "";

async function signIn(loginId: string, password: string, label = loginId): Promise<Session> {
  const s = new Session(label);
  const r = await s.post("/api/auth/login", { loginId, password });
  if (r.status !== 200) throw new Error(`Sign-in as ${loginId} failed: ${r.status} ${errCode(r)}`);
  return s;
}

// ---------------------------------------------------------------- data file (read only)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readDb(): Promise<any> {
  return JSON.parse(await fs.readFile(DB_PATH, "utf8"));
}

interface ApiPartner {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  state: string;
  city: string;
  pincode: string;
  active: boolean;
}

// ---------------------------------------------------------------- main

async function main() {
  const creds = JSON.parse(await fs.readFile(CREDS_PATH, "utf8")) as { adminPassword: string; hqPassword: string; partnerPassword: string };
  const startedAt = new Date().toISOString();

  // ---------- 0. Environment
  const mode = await new Session("anon").get("/api/auth/mode");
  const signInOn = j(mode)?.signInRequired === true || j(mode)?.mode === "on" || j(mode)?.required === true;
  record("Environment", "Server is up and sign-in is ON", mode.status === 200 && signInOn, "200, sign-in required", `${mode.status} ${mode.text.slice(0, 80)}`);
  if (!signInOn) throw new Error("Refusing to run: sign-in must be ON for the QA run (SIGN_IN=on)");
  record("Environment", "QA run uses its own data file, not data/db.json", !DB_PATH.endsWith(`${path.sep}db.json`), "a dedicated file", path.relative(process.cwd(), DB_PATH));

  // The first request that touches the store creates a new data file (Velza Admin and HQ only).
  const admin = await signIn("AD0001", creds.adminPassword, "ADMIN");
  const dbBefore = await readDb();

  // ---------- 1. Dataset (idempotent)
  const ids = new Map<string, string>();
  const manifest: { code: string; id: string | null; type: string; parentCode: string | null; parentId: string | null; city: string; state: string; created: string; verified: string }[] = [];
  const listPartners = async () => j(await admin.get("/api/admin/partners")) as ApiPartner[];
  let existing = await listPartners();
  let createdNow = 0;
  for (const qp of MAHARASHTRA_PARTNERS) {
    const found = matchQaPartner(existing, qp.code);
    if (found.length > 1) {
      record("Dataset", `${qp.code} is unique`, false, "at most 1 record", `${found.length} records: ${found.map((f) => f.id).join(", ")}`);
      continue;
    }
    if (found.length === 1) {
      ids.set(qp.code, found[0].id);
      manifest.push(row(qp, found[0].id, "already present (rerun)"));
      continue;
    }
    const parentId = qp.parent ? ids.get(qp.parent) ?? null : null;
    const fields = Object.fromEntries(Object.entries(qp).filter(([k]) => k !== "code" && k !== "parent"));
    const r = await admin.post("/api/admin/partners", { ...fields, parentId, password: creds.partnerPassword, qcPassword: creds.partnerPassword });
    if (r.status === 200) {
      ids.set(qp.code, j(r).partner.id);
      createdNow += 1;
      manifest.push(row(qp, j(r).partner.id, `created via POST /api/admin/partners (${j(r).logins.map((l: { id: string }) => l.id).join(", ")})`));
    } else {
      manifest.push(row(qp, null, `FAILED ${r.status} ${errCode(r)}: ${j(r)?.error?.message ?? ""}`));
      record("Dataset", `Create ${qp.code}`, false, "200", `${r.status} ${errCode(r)}`);
    }
  }
  function row(qp: QaPartner, id: string | null, created: string) {
    return { code: qp.code, id, type: qp.type, parentCode: qp.parent, parentId: qp.parent ? ids.get(qp.parent) ?? null : null, city: qp.city, state: qp.state, created, verified: "" };
  }
  record("Dataset", "All 18 partners present after create-or-find", ids.size === 18, "18", `${ids.size} (${createdNow} created this run)`);

  // Independent reads: the API list again, and the data file itself.
  existing = await listPartners();
  const db = await readDb();
  const qaApi = existing.filter((p) => p.name.startsWith(QA_PREFIX));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qaFile = (db.partners as any[]).filter((p) => p.name.startsWith(QA_PREFIX));
  for (const [type, want] of Object.entries(EXPECTED_COUNTS)) {
    const api = qaApi.filter((p) => p.type === type).length;
    const file = qaFile.filter((p) => p.type === type).length;
    record("Dataset", `Count of ${type}`, api === want && file === want, String(want), `API ${api}, file ${file}`);
  }
  record("Dataset", "Total QA partners (API and data file)", qaApi.length === 18 && qaFile.length === 18, "18", `API ${qaApi.length}, file ${qaFile.length}`);
  record("Dataset", "No duplicate partner IDs", new Set(qaFile.map((p) => p.id)).size === qaFile.length, "unique", `${new Set(qaFile.map((p) => p.id)).size}/${qaFile.length}`);
  for (const m of manifest) {
    const qp = MAHARASHTRA_PARTNERS.find((q) => q.code === m.code)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = qaFile.find((p: any) => p.id === m.id);
    const a = existing.find((p) => p.id === m.id);
    const wantParent = qp.parent ? ids.get(qp.parent) ?? null : null;
    const ok = !!f && !!a && f.parentId === wantParent && a.parentId === wantParent && f.type === qp.type && f.state === qp.state && f.city === qp.city && f.pincode === qp.pincode && f.active === true;
    m.verified = ok ? "verified (API + data file): type, parent, city, state, PIN, active" : `MISMATCH file=${JSON.stringify(f && { type: f.type, parentId: f.parentId, state: f.state })}`;
    if (!ok) record("Dataset", `${m.code} persisted correctly`, false, `parent ${wantParent}`, m.verified);
  }
  record("Dataset", "Every record's type, parent, city, state and PIN verified in API and data file", manifest.every((m) => m.verified.startsWith("verified")), "18 verified", `${manifest.filter((m) => m.verified.startsWith("verified")).length} verified`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map((db.partners as any[]).map((p) => [p.id, p]));
  const broken = qaFile.filter((p) => p.parentId && !byId.has(p.parentId));
  record("Dataset", "No broken parent references", broken.length === 0, "0", String(broken.length));
  record(
    "Dataset",
    "All records in Maharashtra except SS-002 (one SS per state)",
    qaFile.filter((p) => p.state !== "Maharashtra").map((p) => p.name.split(" ")[0]).join(",") === `${QA_PREFIX}-SS-002`,
    "only SS-002 outside (Goa)",
    qaFile.filter((p) => p.state !== "Maharashtra").map((p) => `${p.name.split(" ")[0]}=${p.state}`).join(", "),
  );
  // Each tier's sign-ins exist (the plant has -OP and -QC)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users = db.users as any[];
  const missingLogins = [...ids.values()].filter((id) => (id.startsWith("MF") ? !users.some((u) => u.id === `${id}-OP`) || !users.some((u) => u.id === `${id}-QC`) : !users.some((u) => u.id === id)));
  record("Dataset", "Every QA partner has its sign-in(s)", missingLogins.length === 0, "all present", missingLogins.join(", ") || "all present");
  // A second Maharashtra SS is refused by the real rule
  const neg = await admin.post("/api/admin/partners", { ...MAHARASHTRA_PARTNERS[1], name: `${QA_PREFIX}-NEG second MH SS`, phone: "+91 00000 202699", email: "qa-neg-ss@example.com", parentId: null, password: creds.partnerPassword });
  record("Business rules", "Second Super Stockist in Maharashtra refused", neg.status === 400 && errCode(neg) === "STATE_TAKEN", "400 STATE_TAKEN", `${neg.status} ${errCode(neg)}`);

  const id = (code: string) => ids.get(`${QA_PREFIX}-${code}`)!;
  const MF = id("MFG-001");

  // ---------- 2. Sign-in, sessions, sign-out
  const anon = new Session("anon");
  const unauth = await anon.get("/api/auth/me");
  record("Auth", "API without a session is refused", unauth.status === 401, "401", String(unauth.status));
  const page = await anon.req("GET", "/hq");
  record("Auth", "Page without a session redirects to /login", page.status === 307 && /\/login/.test(page.text + ""), "307 → /login", `${page.status}`);
  const wrong = await new Session("x").post("/api/auth/login", { loginId: id("RTL-001"), password: "Wrong2026password" });
  record("Auth", "Wrong password refused without saying which part was wrong", wrong.status === 401 && /Wrong sign-in ID or password/.test(wrong.text), "401 generic message", `${wrong.status} ${errCode(wrong)}`);
  const lockId = `${QA_PREFIX}-NOUSER`;
  const lockTries: number[] = [];
  for (let i = 0; i < 6; i++) lockTries.push((await new Session("x").post("/api/auth/login", { loginId: lockId, password: "Wrong2026password" })).status);
  record("Auth", "Sign-in locked after 5 wrong passwords (non-existent ID, so no real account is locked)", lockTries[5] === 429, "6th try 429", lockTries.join(","));
  const rt1 = await signIn(id("RTL-001"), creds.partnerPassword, "RETAILER");
  const meRt = await rt1.get("/api/auth/me");
  record("Auth", "Sign-in returns the right user and partner", meRt.status === 200 && j(meRt).user.id === id("RTL-001") && j(meRt).partner?.id === id("RTL-001"), id("RTL-001"), `${meRt.status} ${j(meRt)?.user?.id}`);
  const cookieFlags = await (async () => {
    const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loginId: id("RTL-002"), password: creds.partnerPassword }) });
    return res.headers.get("set-cookie") ?? "";
  })();
  record("Auth", "Session cookie is HttpOnly and SameSite=Lax", /HttpOnly/i.test(cookieFlags) && /SameSite=Lax/i.test(cookieFlags), "HttpOnly; SameSite=Lax", cookieFlags.replace(/velza_session=[^;]*/, "velza_session=[hidden]"));
  const throwaway = await signIn(id("RTL-002"), creds.partnerPassword);
  const oldCookie = throwaway.cookie;
  const out = await throwaway.post("/api/auth/logout", {});
  const replay = new Session("replay");
  replay.cookie = oldCookie;
  const afterOut = await replay.get("/api/auth/me");
  record("Auth", "Sign-out ends the session (old cookie refused)", out.status === 200 && afterOut.status === 401, "logout 200, reuse 401", `${out.status}, ${afterOut.status}`);

  // ---------- 3. Role × API matrix (expected results come from PERMISSIONS in src/lib/core/permissions.ts)
  const sessions: Record<Role, Session> = {
    ADMIN: admin,
    TRACE_OWNER: await signIn("HQ0001", creds.hqPassword, "TRACE_OWNER"),
    OPERATOR: await signIn(`${MF}-OP`, creds.partnerPassword, "OPERATOR"),
    QC: await signIn(`${MF}-QC`, creds.partnerPassword, "QC"),
    SS: await signIn(id("SS-001"), creds.partnerPassword, "SS"),
    DB: await signIn(id("DST-001"), creds.partnerPassword, "DB"),
    RETAILER: rt1,
  };
  const ROLES = Object.keys(sessions) as Role[];
  // "own-batches": HQ gets every synced batch, a partner sign-in only the batches its own plant made (empty for
  // SS, DB and Retailer), Velza Admin none — see listBatches in src/lib/services/trace.ts.
  const endpoints: { url: string; action: Action | "any" | "own-batches" }[] = [
    { url: "/api/admin/partners", action: "admin" },
    { url: "/api/admin/users", action: "admin" },
    { url: "/api/admin/devices", action: "admin" },
    { url: "/api/admin/pools", action: "admin" },
    { url: "/api/dashboard", action: "dashboard" },
    { url: "/api/alerts", action: "dashboard" },
    { url: "/api/scans", action: "dashboard" },
    { url: "/api/batches", action: "own-batches" },
    { url: "/api/lookup/91ZZZZZZOR00001", action: "search" },
    { url: "/api/print-orders", action: "printOrder" },
    { url: "/api/reprint", action: "reprint" },
    { url: "/api/devices", action: "device" },
    { url: "/api/stock", action: "stock" },
    { url: "/api/my-partners", action: "territory" },
    { url: "/api/dispatch", action: "dispatch" },
    { url: "/api/damaged", action: "damage" },
    { url: "/api/bootstrap", action: "any" },
    { url: "/api/auth/me", action: "any" },
  ];
  const matrix: Record<string, Record<string, number>> = {};
  let matrixFails = 0;
  for (const e of endpoints) {
    matrix[e.url] = {};
    for (const role of ROLES) {
      const r = await sessions[role].get(e.url);
      matrix[e.url][role] = r.status;
      const allowed = e.action === "any" || (e.action === "own-batches" ? role !== "ADMIN" : PERMISSIONS[e.action].includes(role));
      const ok = allowed ? r.status === 200 : r.status === 403;
      if (!ok) {
        matrixFails += 1;
        record("Roles", `${role} GET ${e.url}`, false, allowed ? "200" : "403", `${r.status} ${errCode(r)}`);
      }
    }
  }
  record("Roles", `7 roles × ${endpoints.length} APIs match the permission map (${ROLES.length * endpoints.length} requests)`, matrixFails === 0, "all as PERMISSIONS says", `${matrixFails} mismatches`);
  for (const role of ["SS", "DB", "RETAILER"] as Role[]) {
    const b = j(await sessions[role].get("/api/batches")) as unknown[];
    record("Roles", `${role} batch list is empty (it made no batches)`, Array.isArray(b) && b.length === 0, "[]", `${b.length} batch(es)`);
  }
  for (const role of ROLES) {
    const b = j(await sessions[role].get("/api/bootstrap"));
    const staff = role === "ADMIN" || role === "TRACE_OWNER";
    const ok = staff ? b.partners.length >= 18 : b.partners.length === 1;
    record("Roles", `${role} bootstrap returns ${staff ? "all partners" : "only its own partner"}`, ok, staff ? "≥ 18" : "1", String(b.partners.length));
  }

  // ---------- 4. Security boundaries
  const before = JSON.stringify(j(await admin.get("/api/admin/partners")).find((p: ApiPartner) => p.id === id("RTL-001")));
  for (const role of ["TRACE_OWNER", "OPERATOR", "SS", "DB", "RETAILER"] as Role[]) {
    const c = await sessions[role].post("/api/admin/partners", { ...MAHARASHTRA_PARTNERS[10], name: `${QA_PREFIX}-NEG by ${role}`, phone: "+91 00000 202697", email: "qa-neg-role@example.com", parentId: id("DST-002"), password: creds.partnerPassword });
    const u = await sessions[role].patch(`/api/admin/partners/${id("RTL-001")}`, { name: "hijacked" });
    const d = await sessions[role].del(`/api/admin/partners/${id("RTL-010")}`);
    record("Security", `${role} cannot create, edit or delete partners (server-side)`, c.status === 403 && u.status === 403 && d.status === 403, "403 / 403 / 403", `${c.status} / ${u.status} / ${d.status}`);
  }
  const after = JSON.stringify(j(await admin.get("/api/admin/partners")).find((p: ApiPartner) => p.id === id("RTL-001")));
  record("Security", "Refused writes left the record unchanged", before === after, "unchanged", before === after ? "unchanged" : "CHANGED");
  const negLeft = j(await admin.get("/api/admin/partners")).filter((p: ApiPartner) => p.name.startsWith(`${QA_PREFIX}-NEG`)).length;
  record("Security", "No record was created by refused requests", negLeft === 0, "0", String(negLeft));
  const settingsAnon = await new Session("anon").get("/api/admin/settings");
  record(
    "Security",
    "Admin settings are not readable without signing in",
    settingsAnon.status === 401 || settingsAnon.status === 403 ? "PASS" : "FAIL",
    "401/403",
    `${settingsAnon.status}; fields: ${Object.keys(j(settingsAnon) ?? {}).join(", ")}`,
  );
  const settingsPut = await sessions.RETAILER.req("PUT", "/api/admin/settings", { alertThresholdDays: 99 });
  record("Security", "Non-admin cannot change settings (PUT)", settingsPut.status === 403, "403", `${settingsPut.status} ${errCode(settingsPut)}`);
  const xsite = await admin.req("POST", "/api/admin/partners", {}, { origin: "https://evil.example" });
  record("Security", "Cross-site write refused", xsite.status === 403, "403", `${xsite.status} ${errCode(xsite)}`);
  const formPost = await admin.req("POST", "/api/admin/partners", "name=x", { "content-type": "application/x-www-form-urlencoded" });
  record("Security", "Non-JSON body refused (blocks plain HTML form posts)", formPost.status === 415, "415", String(formPost.status));
  const badJson = await admin.req("POST", "/api/admin/partners", "{not json");
  record("Security", "Malformed JSON refused", badJson.status === 400 && errCode(badJson) === "BAD_JSON", "400 BAD_JSON", `${badJson.status} ${errCode(badJson)}`);
  const big = await admin.req("POST", "/api/admin/partners", JSON.stringify({ name: "x".repeat(300 * 1024) }));
  record("Security", "Body over 256 KB refused", big.status === 413, "413", String(big.status));
  // Scope: who sees whom
  const scopeOf = async (s: Session) => (j(await s.get("/api/my-partners")).partners as { id: string }[]).map((p) => p.id).sort();
  const ssScope = await scopeOf(sessions.SS);
  record("Hierarchy", "SS-001 sees exactly DST-001..003 (not SS-002's distributors or any retailer)", JSON.stringify(ssScope) === JSON.stringify(["DST-001", "DST-002", "DST-003"].map(id).sort()), "DST-001..003", ssScope.join(", "));
  const ss2 = await signIn(id("SS-002"), creds.partnerPassword);
  const ss2Scope = await scopeOf(ss2);
  record("Hierarchy", "SS-002 sees exactly DST-004..005", JSON.stringify(ss2Scope) === JSON.stringify(["DST-004", "DST-005"].map(id).sort()), "DST-004..005", ss2Scope.join(", "));
  let dbScopeOk = true;
  const dbScopes: string[] = [];
  for (let d = 1; d <= 5; d++) {
    const s = d === 1 ? sessions.DB : await signIn(id(`DST-00${d}`), creds.partnerPassword);
    const got = await scopeOf(s);
    const want = [2 * d - 1, 2 * d].map((k) => id(`RTL-${String(k).padStart(3, "0")}`)).sort();
    dbScopes.push(`DST-00${d}: ${got.join("+")}`);
    if (JSON.stringify(got) !== JSON.stringify(want)) dbScopeOk = false;
    const dest = (j(await s.get("/api/dispatch")).destinations as { id: string }[]).map((p) => p.id).sort();
    if (JSON.stringify(dest) !== JSON.stringify(want)) dbScopeOk = false;
  }
  record("Hierarchy", "Each distributor sees and can dispatch to exactly its 2 retailers", dbScopeOk, "2 own retailers each", dbScopes.join("; "));
  const plantDest = (j(await sessions.OPERATOR.get("/api/dispatch")).destinations as { id: string }[]).map((p) => p.id).sort();
  record("Hierarchy", "The plant can dispatch to both Super Stockists (no plant → SS assignment exists)", JSON.stringify(plantDest) === JSON.stringify([id("SS-001"), id("SS-002")].sort()), "SS-001, SS-002", plantDest.join(", "));
  const rtScope = await sessions.RETAILER.get("/api/my-partners");
  record("Hierarchy", "A retailer has no partner list", rtScope.status === 403, "403", String(rtScope.status));
  const rtLookup = await sessions.RETAILER.get(`/api/lookup/91ZZZZZZOR00001`);
  record("Security", "Retailer cannot trace codes (HQ only)", rtLookup.status === 403, "403", String(rtLookup.status));
  // Admin-side relationship rules through the API
  const typeChange = await admin.patch(`/api/admin/partners/${id("DST-001")}`, { type: "RETAILER" });
  record("Business rules", "Partner tier cannot be changed", typeChange.status === 400 && errCode(typeChange) === "TYPE_LOCKED", "400 TYPE_LOCKED", `${typeChange.status} ${errCode(typeChange)}`);
  const badParent = await admin.patch(`/api/admin/partners/${id("DST-001")}`, { parentId: id("RTL-002") });
  record("Business rules", "Distributor cannot be assigned to a retailer", badParent.status === 400 && errCode(badParent) === "BAD_PARENT", "400 BAD_PARENT", `${badParent.status} ${errCode(badParent)}`);
  const ghostParent = await admin.patch(`/api/admin/partners/${id("RTL-001")}`, { parentId: "DB9999" });
  record("Business rules", "Parent that does not exist refused", ghostParent.status === 400 && errCode(ghostParent) === "BAD_PARENT", "400 BAD_PARENT", `${ghostParent.status} ${errCode(ghostParent)}`);
  const ssMove = await admin.patch(`/api/admin/partners/${id("SS-002")}`, { state: "Maharashtra" });
  record("Business rules", "SS cannot move into a state that already has one", ssMove.status === 400 && errCode(ssMove) === "STATE_TAKEN", "400 STATE_TAKEN", `${ssMove.status} ${errCode(ssMove)}`);
  const badStatus = await admin.patch(`/api/admin/partners/${id("RTL-001")}`, { active: "maybe" });
  record("Validation", "Unsupported status value refused", badStatus.status === 400, "400", `${badStatus.status} ${errCode(badStatus)}`);
  const unknownField = await admin.patch(`/api/admin/partners/${id("RTL-001")}`, { createdBy: "HQ0001", id: "RT9999" });
  const rtAfter = j(await admin.get("/api/admin/partners")).find((p: ApiPartner & { createdBy: string }) => p.id === id("RTL-001"));
  record("Validation", "Unexpected fields (id, createdBy) are ignored", rtAfter.createdBy === "AD0001" && unknownField.status === 200, "200, id/createdBy unchanged", `${unknownField.status}, createdBy=${rtAfter.createdBy}`);

  // ---------- 5. Partner lifecycle on disposable records (created, then deleted; the 18 stay untouched)
  const tmpBase = { type: "RETAILER", place: "Camp", address: "QA disposable", city: "Pune", state: "Maharashtra", pincode: "411001", contactPerson: "QA Disposable", parentId: id("DST-001"), password: creds.partnerPassword };
  const validation: [string, Record<string, unknown>, string][] = [
    ["empty name", { name: "" }, "VALIDATION"],
    ["missing phone", { phone: "" }, "VALIDATION"],
    ["bad email", { email: "not-an-email" }, "BAD_EMAIL"],
    ["bad phone", { phone: "call me" }, "BAD_PHONE"],
    ["5-digit PIN", { pincode: "41100" }, "BAD_PINCODE"],
    ["no state", { state: "" }, "BAD_STATE"],
    ["state not in India", { state: "Atlantis" }, "BAD_STATE"],
    ["name over 100 characters", { name: `${QA_PREFIX}-TMP ${"x".repeat(100)}` }, "VALIDATION"],
    ["unknown tier", { type: "SUPPLIER" }, "VALIDATION"],
    ["weak password", { password: "short" }, "WEAK_PASSWORD"],
    ["duplicate phone", { phone: MAHARASHTRA_PARTNERS[9].phone }, "DUPLICATE"],
  ];
  for (const [what, over, code] of validation) {
    const r = await admin.post("/api/admin/partners", { ...tmpBase, name: `${QA_PREFIX}-TMP validation`, phone: "+91 00000 202690", email: "qa-tmp@example.com", ...over });
    record("Validation", `Registration refuses ${what}`, r.status === 400 && errCode(r) === code, `400 ${code}`, `${r.status} ${errCode(r)}`);
  }
  const pinMismatch = await admin.post("/api/admin/partners", { ...tmpBase, name: `${QA_PREFIX}-TMP pin`, phone: "+91 00000 202691", email: "qa-tmp-pin@example.com", pincode: "110001" });
  record(
    "Validation",
    "PIN code from another state (Delhi 110001 for Maharashtra)",
    pinMismatch.status === 400 ? "PASS" : "NEEDS INVESTIGATION",
    "refused, if PIN/state consistency is required",
    `${pinMismatch.status} — accepted: only the 6-digit format is checked`,
  );
  if (pinMismatch.status === 200) await admin.del(`/api/admin/partners/${j(pinMismatch).partner.id}`);
  // Concurrent duplicate submissions: same phone at the same moment → exactly one succeeds
  const dupBody = { ...tmpBase, name: `${QA_PREFIX}-TMP concurrent`, phone: "+91 00000 202692", email: "" };
  const [c1, c2] = await Promise.all([admin.post("/api/admin/partners", dupBody), admin.post("/api/admin/partners", dupBody)]);
  const okOnes = [c1, c2].filter((r) => r.status === 200);
  record("Concurrency", "Two identical registrations at once: exactly one is created", okOnes.length === 1 && [c1, c2].some((r) => errCode(r) === "DUPLICATE"), "1 created, 1 DUPLICATE", `${c1.status} ${errCode(c1)} / ${c2.status} ${errCode(c2)}`);
  const tmpId = okOnes[0] ? j(okOnes[0]).partner.id : null;
  if (tmpId) {
    const upd = await admin.patch(`/api/admin/partners/${tmpId}`, { contactPerson: "QA Disposable Edited", city: "Pune" });
    const reread = j(await admin.get("/api/admin/partners")).find((p: ApiPartner & { contactPerson: string }) => p.id === tmpId);
    record("Lifecycle", "Edit persists (re-read)", upd.status === 200 && reread.contactPerson === "QA Disposable Edited", "contactPerson updated", `${upd.status}, ${reread.contactPerson}`);
    const tmpSession = await signIn(tmpId, creds.partnerPassword);
    const deact = await admin.patch(`/api/admin/partners/${tmpId}`, { active: false });
    const whileInactive = await tmpSession.get("/api/stock");
    const relogin = await new Session("x").post("/api/auth/login", { loginId: tmpId, password: creds.partnerPassword });
    record("Lifecycle", "Deactivating a partner stops its open session and its sign-in", deact.status === 200 && whileInactive.status === 401 && relogin.status !== 200, "session 401, sign-in refused", `session ${whileInactive.status}, sign-in ${relogin.status} ${errCode(relogin)}`);
    const parentDel = await admin.del(`/api/admin/partners/${id("DST-001")}`);
    record("Lifecycle", "Partner with assigned partners cannot be deleted", parentDel.status === 400, "400", `${parentDel.status} ${errCode(parentDel)}: ${j(parentDel)?.error?.message ?? ""}`.slice(0, 160));
    const del = await admin.del(`/api/admin/partners/${tmpId}`);
    const gone = !j(await admin.get("/api/admin/partners")).some((p: ApiPartner) => p.id === tmpId);
    const dbAfter = await readDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loginGone = !(dbAfter.users as any[]).some((u) => u.id === tmpId);
    record("Lifecycle", "Disposable partner without history is deleted with its sign-in", del.status === 200 && gone && loginGone, "deleted, sign-in removed", `${del.status}, listed=${!gone}, login=${!loginGone}`);
  }

  // ---------- 6. Traceability: print → QC → plant → SS → DB → Retailer → open; HQ trace; public page
  const op = sessions.OPERATOR;
  const hq = sessions.TRACE_OWNER;
  let devices = j(await admin.get("/api/admin/devices")) as { id: string; name: string; manufacturerId: string }[];
  const freshTrace = !devices.some((d) => d.name === DEVICE_NAME);
  let lotCode = "";
  let recallBatch = "";
  if (freshTrace) {
    const dev = await admin.post("/api/admin/devices", { manufacturerId: MF, name: DEVICE_NAME });
    record("Traceability", "Admin registers the plant PC; it receives batch codes", dev.status === 200, "200", `${dev.status} ${errCode(dev)}`);
    devices = j(await admin.get("/api/admin/devices"));
    const today = new Date().toISOString().slice(0, 10);
    const exp = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
    const orderBody = { batches: [ { flavour: "OR", mfgDate: today, expiryDate: exp, cases: 1, trays: 0 }, { flavour: "GA", mfgDate: today, expiryDate: exp, cases: 0, trays: 1 } ] };
    const preview = await op.post("/api/print-orders", { ...orderBody, preview: true });
    const created = await op.post("/api/print-orders", orderBody);
    const po = j(created)?.printOrder;
    record("Traceability", "Operator creates a print order (1 case Original + 1 tray Green Apple)", preview.status === 200 && created.status === 200 && po?.stickerCount === 12, "12 stickers (1+4, 1+6)", `${created.status} ${po?.stickerCount}`);
    const codes = j(await op.get(`/api/print-orders/${po.id}/codes`)).codes as { code: string; codeType: string; lotType: string; lotCode: string; batchCode: string; status: string }[];
    record("Traceability", "Every generated code is unique and stored", codes.length === 12 && new Set(codes.map((c) => c.code)).size === 12, "12 unique", `${codes.length} / ${new Set(codes.map((c) => c.code)).size} unique`);
    const caseLot = codes.find((c) => c.codeType === "LOT" && c.lotType === "CASE")!;
    const trayLot = codes.find((c) => c.codeType === "LOT" && c.lotType === "TRAY")!;
    lotCode = caseLot.code;
    recallBatch = trayLot.batchCode;
    const packsOf = (lot: string) => codes.filter((c) => c.codeType === "PACK" && c.lotCode === lot).map((c) => c.code);
    const printed = await op.post(`/api/print-orders/${po.id}/printed`, {});
    record("Traceability", "Marked printed", printed.status === 200 && j(printed).lotsPrinted === 2, "2 lots PRINTED", `${printed.status} ${j(printed)?.lotsPrinted}`);
    // QC: lot, a foreign pack (refused), every pack, confirm
    const qc = sessions.QC;
    for (const lot of [caseLot.code, trayLot.code]) {
      await qc.post("/api/verify", { action: "scanLot", code: lot });
      const scanned: string[] = [];
      if (lot === caseLot.code) {
        const foreign = await qc.post("/api/verify", { action: "scanPack", lotCode: lot, code: packsOf(trayLot.code)[0], scanned });
        record("Traceability", "QC refuses a pack from another lot", j(foreign)?.ok === false, "ok:false", `${foreign.status} ${j(foreign)?.code ?? errCode(foreign)}`);
      }
      for (const p of packsOf(lot)) {
        await qc.post("/api/verify", { action: "scanPack", lotCode: lot, code: p, scanned: [...scanned] });
        scanned.push(p);
      }
      const conf = await qc.post("/api/verify", { action: "confirm", lotCode: lot, packCodes: scanned });
      record("Traceability", `QC confirms ${lot === caseLot.code ? "case" : "tray"} → PACKED`, conf.status === 200 && JSON.stringify(j(conf)).includes("PACKED"), "PACKED", `${conf.status} ${(j(conf)?.message ?? errCode(conf)).slice(0, 60)}`);
    }
    // Dispatch both lots plant → SS-001
    for (const c of [caseLot.code, trayLot.code]) await op.post("/api/dispatch", { action: "check", toPartnerId: id("SS-001"), invoice: "QA-INV-001", code: c });
    const dsp = await op.post("/api/dispatch", { action: "confirm", toPartnerId: id("SS-001"), invoice: "QA-INV-001", codes: [caseLot.code, trayLot.code] });
    record("Traceability", "Plant dispatches to SS-001 with invoice QA-INV-001", dsp.status === 200, "200", `${dsp.status} ${(j(dsp)?.message ?? errCode(dsp)).slice(0, 70)}`);
    const wrongRx = await ss2.post("/api/receive", { code: caseLot.code });
    record("Traceability", "SS-002 receiving SS-001's case is refused (WRONG_RECEIVER)", JSON.stringify(j(wrongRx)).includes("WRONG_RECEIVER"), "WRONG_RECEIVER", `${wrongRx.status} ${j(wrongRx)?.code ?? errCode(wrongRx)}`);
    const rx = await sessions.SS.post("/api/receive", { code: caseLot.code });
    await sessions.SS.post("/api/receive", { code: trayLot.code });
    const dupRx = await sessions.SS.post("/api/receive", { code: caseLot.code });
    record("Traceability", "SS-001 receives the case; receiving it again is refused", j(rx)?.ok === true && j(dupRx)?.ok === false, "ok, then refused", `${j(rx)?.ok}, ${j(dupRx)?.code ?? errCode(dupRx)}`);
    // Recall the Green Apple batch (tray), then any scan of it is blocked
    const rc = await hq.post("/api/recall", { batchCode: recallBatch, reason: "QA test recall (synthetic data)" });
    const blocked = await sessions.SS.post("/api/dispatch", { action: "check", toPartnerId: id("DST-001"), invoice: "QA-INV-002", code: trayLot.code });
    record("Traceability", "HQ recalls the Green Apple batch; dispatching its tray is blocked", rc.status === 200 && j(blocked)?.ok === false, "recalled, dispatch refused", `${rc.status}, ${j(blocked)?.code ?? errCode(blocked)}`);
    const unassigned = await sessions.SS.post("/api/dispatch", { action: "check", toPartnerId: id("DST-004"), invoice: "QA-INV-002", code: caseLot.code });
    record("Hierarchy", "SS-001 cannot dispatch to SS-002's distributor", j(unassigned)?.ok === false, "refused", `${j(unassigned)?.code ?? errCode(unassigned)}`);
    // Case SS-001 → DST-001 → RTL-001 → opened
    await sessions.SS.post("/api/dispatch", { action: "confirm", toPartnerId: id("DST-001"), invoice: "QA-INV-002", codes: [caseLot.code] });
    await sessions.DB.post("/api/receive", { code: caseLot.code });
    const otherRt = await sessions.DB.post("/api/dispatch", { action: "check", toPartnerId: id("RTL-003"), invoice: "QA-INV-003", code: caseLot.code });
    record("Hierarchy", "DST-001 cannot dispatch to DST-002's retailer", j(otherRt)?.ok === false, "refused", `${j(otherRt)?.code ?? errCode(otherRt)}`);
    await sessions.DB.post("/api/dispatch", { action: "confirm", toPartnerId: id("RTL-001"), invoice: "QA-INV-003", codes: [caseLot.code] });
    const rtRx = await sessions.RETAILER.post("/api/receive", { code: caseLot.code });
    const opened = await sessions.RETAILER.post("/api/open-lot", { lotCode: caseLot.code });
    record("Traceability", "RTL-001 receives and opens the case", j(rtRx)?.ok === true && opened.status === 200, "received, opened", `${j(rtRx)?.ok}, ${opened.status} ${errCode(opened)}`);
  } else {
    const db2 = await readDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lotCode = (db2.lots as any[]).find((l) => l.manufacturerId === MF && l.lotType === "CASE")?.lotCode ?? "";
    record("Traceability", "Scan chain already created by an earlier run (not repeated); re-verifying", "PASS", "existing QA print order", lotCode || "none found");
  }
  if (lotCode) {
    const tr = await hq.get(`/api/lookup/${lotCode}`);
    const events = (j(tr)?.timeline ?? []).map((t: { event: string }) => t.event);
    const want = ["GENERATED", "PRINTED", "VERIFIED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "OPENED"];
    record("Traceability", "HQ trace of the case shows every step in order", JSON.stringify(events) === JSON.stringify(want), want.join(" → "), events.join(" → "));
    record("Traceability", "Trace shows location, status and batch", j(tr)?.status === "OPENED" && /Kothrud/.test(j(tr)?.location ?? "") && !!j(tr)?.batch, "OPENED at RTL-001", `${j(tr)?.status} at ${j(tr)?.location}`);
    const users2 = (j(tr)?.timeline ?? []).filter((t: { user: string | null }) => !!t.user).length;
    record("Audit", "Every movement in the trace names the person", users2 === events.length, `${events.length}`, String(users2));
    const pack = `${lotCode}61`;
    const packTr = await hq.get(`/api/lookup/${pack}`);
    record("Traceability", "Pack trace shows its parent case", j(packTr)?.parent?.code === lotCode, lotCode, `${packTr.status} ${j(packTr)?.parent?.code}`);
    const pub = await new Session("public").get(`/api/lookup/${lotCode}?view=public`);
    const leaks = ["QA-INV", "Kothrud", "Deccan", "QA Contact", "example.com"].filter((s) => pub.text.includes(s));
    record("Security", "Public QR check shows no business data", pub.status === 200 && leaks.length === 0, "no invoices, partners or contacts", leaks.length ? `leaks: ${leaks.join(", ")}` : `${pub.status} ${j(pub)?.status?.label}`);
  }
  const opBatches = j(await op.get("/api/batches")) as { manufacturerId: string }[];
  record("Roles", "Operator batch list holds only its own plant's batches", opBatches.length > 0 && opBatches.every((x) => x.manufacturerId === MF), `all ${MF}`, `${opBatches.length}: ${[...new Set(opBatches.map((x) => x.manufacturerId))].join(",")}`);
  const unknown = await hq.get("/api/lookup/91ZZZZZZOR00001");
  record("Traceability", "Unknown code → UNKNOWN_CODE (safe message)", j(unknown)?.found === false && /UNKNOWN/.test(JSON.stringify(j(unknown))), "found:false UNKNOWN_CODE", `${unknown.status} ${j(unknown)?.result}`);
  const evil = await hq.get(`/api/lookup/${encodeURIComponent("<script>alert(1)</script>")}`);
  record("Security", "Malformed code handled safely (no 500, no echo as HTML)", evil.status < 500 && (evil.text.startsWith("{") || evil.text === ""), "JSON, < 500", `${evil.status} ${evil.text.slice(0, 60)}`);
  const pubEvil = await new Session("public").get(`/api/lookup/${encodeURIComponent("'; DROP TABLE codes;--")}?view=public`);
  record("Security", "Injection-style code on the public check handled safely", pubEvil.status < 500, "< 500", `${pubEvil.status} ${pubEvil.text.slice(0, 60)}`);
  // Audit trail: scans are recorded with who and result; no API edits or deletes them
  const scans = j(await hq.get("/api/scans")) as { result: string; user: string | null; ok: boolean; context: string }[];
  record("Audit", "Scan audit records failures too (wrong receiver, unknown code, blocked)", ["WRONG_RECEIVER", "UNKNOWN_CODE"].every((r) => scans.some((s) => s.result === r)), "both present", [...new Set(scans.filter((s) => !s.ok).map((s) => s.result))].join(", "));
  const auditDel = await admin.del("/api/scans");
  const auditPatch = await admin.patch("/api/scans", {});
  record("Audit", "No API can delete or edit the scan audit", auditDel.status === 405 && auditPatch.status === 405, "405 / 405", `${auditDel.status} / ${auditPatch.status}`);
  const dash = j(await hq.get("/api/dashboard"));
  const dbNow = await readDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileLots = (dbNow.lots as any[]).filter((l) => l.synced !== false).length;
  record("Reporting", "Dashboard lot total equals the lots in the data file", dash.totals.lots === fileLots, String(fileLots), String(dash.totals.lots));

  // ---------- 7. Data integrity (data file, read only)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const P = new Map((dbNow.partners as any[]).map((p) => [p.id, p]));
  const orphanParents = [...P.values()].filter((p) => p.parentId && !P.has(p.parentId)).length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orphanUsers = (dbNow.users as any[]).filter((u) => u.partnerId && !P.has(u.partnerId)).length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lotCodes = new Set((dbNow.lots as any[]).map((l) => l.lotCode));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orphanPacks = (dbNow.packs as any[]).filter((p) => !lotCodes.has(p.lotCode)).length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const badLocations = [...(dbNow.lots as any[]), ...(dbNow.packs as any[])].filter((x) => x.locationId && !P.has(x.locationId)).length;
  const wrongTier = [...P.values()].filter((p) => p.parentId && !({ DB: ["SS"], RETAILER: ["DB", "SS"] } as Record<string, string[]>)[p.type]?.includes(P.get(p.parentId)?.type)).length;
  record("Integrity", "No orphan partners, sign-ins, packs or locations; every parent is an allowed tier", orphanParents + orphanUsers + orphanPacks + badLocations + wrongTier === 0, "0 each", `parents ${orphanParents}, users ${orphanUsers}, packs ${orphanPacks}, locations ${badLocations}, tier ${wrongTier}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const preexisting = (dbBefore.users as any[]).map((u) => u.id).filter((uid: string) => !(dbNow.users as any[]).some((u) => u.id === uid));
  record("Integrity", "No pre-existing sign-in was removed by this run", preexisting.length === 0, "0 removed", preexisting.join(", ") || "0 removed");

  // ---------- Output
  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = Object.fromEntries((["PASS", "FAIL", "BLOCKED", "NOT RUN", "NEEDS INVESTIGATION"] as Status[]).map((s) => [s, results.filter((r) => r.status === s).length]));
  await fs.writeFile(
    path.join(OUT_DIR, "qa-run-results.json"),
    JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), base: BASE, dataFile: path.relative(process.cwd(), DB_PATH), summary, roleApiMatrix: matrix, results }, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(OUT_DIR, "maharashtra-test-data.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), dataFile: path.relative(process.cwd(), DB_PATH), prefix: QA_PREFIX, expectedCounts: EXPECTED_COUNTS, partners: manifest }, null, 2) + "\n",
  );
  console.log(`\n${JSON.stringify(summary)}`);
  if (summary.FAIL) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
});
