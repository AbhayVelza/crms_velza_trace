// Endpoint latency on a running server whose data file came from tests/qa/perfGenerate.mjs (sign-in ON).
// Each endpoint: 2 warm-up requests, then N sequential (concurrency 1) and M at concurrency 10.
// Reports median / p95 / p99 (p99 only with ≥ 100 samples), throughput, errors, payload size.
//
//   QA_BASE=http://localhost:3400 QA_DB_PATH=<perf file> node tests/qa/perfBench.mjs --label 100k --out docs/qa/perf-100k.json
//
// Start the server with high rate limits (RATE_LIMIT_PER_MIN etc.), or the limiter, not the app, is measured.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const BASE = process.env.QA_BASE ?? "http://localhost:3400";
const DB_PATH = process.env.QA_DB_PATH;
const LABEL = arg("label", "run");
const OUT = arg("out", `docs/qa/perf-${LABEL}.json`);
const SEQ = Number(arg("seq", "15"));
const CONC_N = Number(arg("conc-n", "30"));
const CAP_MS = Number(arg("cap-ms", "120000"));
const creds = JSON.parse(readFileSync(process.env.QA_CREDENTIALS ?? "data/qa-mh-2026-credentials.json", "utf8"));
// --codes <file> ({ lot, ssLot, dataset }) skips parsing the data file here: at 100k records the server and this
// script would otherwise each hold a copy in memory.
const pre = arg("codes") ? JSON.parse(readFileSync(arg("codes"), "utf8")) : null;
const db = pre ? null : JSON.parse(readFileSync(DB_PATH, "utf8"));

async function signIn(loginId, password) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loginId, password }) });
  if (res.status !== 200) throw new Error(`sign-in ${loginId}: ${res.status}`);
  return /velza_session=[^;]*/.exec(res.headers.get("set-cookie"))[0];
}
const cookies = {
  HQ: await signIn("HQ0001", creds.hqPassword),
  ADMIN: await signIn("AD0001", creds.adminPassword),
  OP: await signIn("MF0001-OP", creds.partnerPassword),
  SS: await signIn("SS0001", creds.partnerPassword),
  RT: await signIn("RT0001", creds.partnerPassword),
};

const lotAtSs = pre ? { lotCode: pre.ssLot } : db.lots.find((l) => l.locationId === "SS0001" && l.status === "AT_SS");
const someLot = pre ? { lotCode: pre.lot } : db.lots[Math.floor(db.lots.length / 2)];
const today = new Date().toISOString().slice(0, 10);
let regN = 0;
const scenarios = [
  { name: "Exact code lookup (HQ trace of a case)", who: "HQ", method: "GET", url: `/api/lookup/${someLot.lotCode}` },
  { name: "Exact code lookup (HQ trace of a pack)", who: "HQ", method: "GET", url: `/api/lookup/${someLot.lotCode}61` },
  { name: "Public QR check", who: null, method: "GET", url: `/api/lookup/${someLot.lotCode}?view=public` },
  { name: "HQ dashboard", who: "HQ", method: "GET", url: "/api/dashboard" },
  { name: "HQ alerts", who: "HQ", method: "GET", url: "/api/alerts" },
  { name: "Scan audit (latest 300)", who: "HQ", method: "GET", url: "/api/scans" },
  { name: "Batch list", who: "HQ", method: "GET", url: "/api/batches" },
  { name: "Partner list (Admin, all partners)", who: "ADMIN", method: "GET", url: "/api/admin/partners" },
  { name: "My partners (Super Stockist)", who: "SS", method: "GET", url: "/api/my-partners" },
  { name: "My stock (Retailer)", who: "RT", method: "GET", url: "/api/stock" },
  { name: "Print orders list (Operator)", who: "OP", method: "GET", url: "/api/print-orders" },
  {
    name: "Print order preview (Operator; plan only, no lot scan)",
    who: "OP",
    method: "POST",
    url: "/api/print-orders",
    body: () => ({ preview: true, batches: [{ flavour: "OR", mfgDate: today, expiryDate: "2027-10-28", cases: 1, trays: 0 }] }),
  },
  {
    name: "Dispatch scan check (write: appends a scan)",
    who: "SS",
    method: "POST",
    url: "/api/dispatch",
    body: () => ({ action: "check", toPartnerId: "DB0001", invoice: "PERF-BENCH", code: lotAtSs.lotCode }),
  },
  {
    name: "Register a partner (write: create)",
    who: "ADMIN",
    method: "POST",
    url: "/api/admin/partners",
    seqOnly: true,
    body: () => {
      regN += 1;
      return { type: "RETAILER", name: `PERF-BENCH ${LABEL} ${regN}`, place: "Perf", address: "Bench", city: "Pune", state: "Maharashtra", pincode: "411001", contactPerson: "Perf", phone: `+91 00002 ${String(Date.now() % 1e6).padStart(6, "0")}${regN}`.slice(0, 20), email: "", parentId: "DB0001", password: creds.partnerPassword };
    },
  },
];

async function call(s) {
  const headers = {};
  if (s.who) headers.cookie = cookies[s.who];
  let body;
  if (s.body) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(s.body());
  }
  const t = performance.now();
  try {
    const res = await fetch(BASE + s.url, { method: s.method, headers, body, signal: AbortSignal.timeout(60_000) });
    const buf = await res.arrayBuffer();
    return { ms: performance.now() - t, ok: res.status === 200, status: res.status, bytes: buf.byteLength };
  } catch (e) {
    return { ms: performance.now() - t, ok: false, status: e.name === "TimeoutError" ? "timeout" : "error", bytes: 0 };
  }
}
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
function stats(samples, wallMs) {
  const ms = samples.map((x) => x.ms);
  const errors = samples.filter((x) => !x.ok);
  return {
    n: samples.length,
    medianMs: Math.round(pct(ms, 50)),
    p95Ms: Math.round(pct(ms, 95)),
    p99Ms: samples.length >= 100 ? Math.round(pct(ms, 99)) : null,
    maxMs: Math.round(Math.max(...ms)),
    throughputPerS: Number(((samples.length / wallMs) * 1000).toFixed(2)),
    errorRate: Number((errors.length / samples.length).toFixed(3)),
    errorStatuses: [...new Set(errors.map((e) => e.status))],
    payloadKB: Math.round(samples[samples.length - 1].bytes / 1024),
  };
}

const results = [];
for (const s of scenarios) {
  await call(s);
  await call(s);
  const seq = [];
  let t = performance.now();
  const seqN = s.seqOnly ? 5 : SEQ;
  while (seq.length < seqN && performance.now() - t < CAP_MS) seq.push(await call(s));
  const seqStats = stats(seq, performance.now() - t);
  let concStats = null;
  if (!s.seqOnly) {
    const conc = [];
    let next = 0;
    t = performance.now();
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        while (next < CONC_N && performance.now() - t < CAP_MS) {
          next += 1;
          conc.push(await call(s));
        }
      }),
    );
    concStats = stats(conc, performance.now() - t);
  }
  results.push({ scenario: s.name, method: s.method, endpoint: s.url.replace(/\?.*/, ""), sequential: seqStats, concurrency10: concStats });
  console.log(`${s.name.padEnd(52)} c1 p50 ${String(seqStats.medianMs).padStart(6)} p95 ${String(seqStats.p95Ms).padStart(6)}${concStats ? `  | c10 p50 ${String(concStats.medianMs).padStart(6)} p95 ${String(concStats.p95Ms).padStart(6)} ${concStats.throughputPerS}/s err ${concStats.errorRate}` : ""}  ${seqStats.payloadKB} KB`);
}

mkdirSync(path.dirname(OUT), { recursive: true });
const sizes = pre
  ? pre.dataset
  : { lots: db.lots.length, packs: db.packs.length, codeRecords: db.lots.length + db.packs.length, partners: db.partners.length, movements: db.movements.length, scans: db.scans.length };
writeFileSync(OUT, JSON.stringify({ label: LABEL, ranAt: new Date().toISOString(), base: BASE, store: "JSON file (STORE=json)", dataset: sizes, settings: { sequential: SEQ, concurrency: 10, concurrentRequests: CONC_N, warmup: 2 }, results }, null, 2) + "\n");
console.log(`→ ${OUT}`);
