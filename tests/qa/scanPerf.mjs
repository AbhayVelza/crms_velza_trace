// Scan throughput and checklist rendering, against an isolated server with its own data (never port 3000).
//   PERF_BASE=http://127.0.0.1:3430 node tests/qa/scanPerf.mjs
// The server's store must hold the e2e sample network (tests/e2e/seed-sample.ts); this script adds 1,000 cases.
// Measures: API latency for 10 / 100 / 500 scans, dispatch checklist load with 1,000 expected units, scan → SCANNED
// time in the browser for 100 keyboard scans, API request count, DOM size and JS heap growth.

import { writeFileSync } from "node:fs";
import { chromium, request } from "@playwright/test";

const BASE = process.env.PERF_BASE ?? "http://127.0.0.1:3430";
if (/:3000\b/.test(BASE)) throw new Error("Refusing to run against port 3000");
const PASSWORD = "Sample2026pass";
const N = Number(process.env.PERF_LOTS ?? 1000);

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.round(Math.max(...xs)), totalMs: Math.round(xs.reduce((a, b) => a + b, 0)) });
async function as(who) {
  const ctx = await request.newContext({ baseURL: BASE });
  const r = await ctx.post("/api/auth/login", { data: { loginId: who, password: PASSWORD } });
  if (r.status() !== 200) throw new Error(`sign in ${who}: ${r.status()}`);
  return ctx;
}
async function timed(fn) {
  const t = performance.now();
  const r = await fn();
  return [performance.now() - t, r];
}

const out = { base: BASE, at: new Date().toISOString(), lots: N };
const op = await as("MF0001-OP");
const qc = await as("MF0001-QC");
const today = new Date().toISOString().slice(0, 10);

// 1,000 cases in one print order (5,000 stickers), confirmed printed.
let [ms, r] = await timed(() => op.post("/api/print-orders", { data: { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: today, expiryDate: `${+today.slice(0, 4) + 1}${today.slice(4)}`, cases: N, trays: 0 }] } }));
const order = (await r.json()).printOrder;
out.createOrderMs = Math.round(ms);
[ms] = await timed(() => op.post(`/api/print-orders/${order.id}/printed`, { data: {} }));
out.markPrintedMs = Math.round(ms);
const lots = order.lotCodes;

// QC pack scans: latency of 10 / 100 / 500 scanPack requests (each one is checked and written to the scan audit).
const packScan = [];
for (let i = 0; i < 125; i++) {
  const lot = lots[i];
  await qc.post("/api/verify", { data: { action: "scanLot", code: lot } });
  const packs = [1, 2, 3, 4].map((s) => `${lot}6${s}`);
  for (const [k, p] of packs.entries()) {
    const [t, res] = await timed(() => qc.post("/api/verify", { data: { action: "scanPack", lotCode: lot, code: p, scanned: packs.slice(0, k) } }));
    if (!(await res.json()).ok) throw new Error(`pack ${p} refused`);
    packScan.push(t);
  }
}
out.qcPackScanApi = { first10: stats(packScan.slice(0, 10)), first100: stats(packScan.slice(0, 100)), all500: stats(packScan) };

// Every lot verified → PACKED so the dispatch checklist expects all of them.
const confirms = [];
for (const lot of lots) {
  const [t] = await timed(() => qc.post("/api/verify", { data: { action: "confirm", lotCode: lot, packCodes: [1, 2, 3, 4].map((s) => `${lot}6${s}`) } }));
  confirms.push(t);
}
out.qcConfirmApi = stats(confirms);

// Browser: Dispatch with 1,000 expected units; 100 keyboard scans.
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "msedge" });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
const heap = async () => {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const m = (await cdp.send("Performance.getMetrics")).metrics;
  return Math.round(m.find((x) => x.name === "JSHeapUsedSize").value / 1024 / 1024 * 10) / 10;
};
let checks = 0;
page.on("request", (q) => q.method() === "POST" && q.url().endsWith("/api/dispatch") && checks++);
await page.request.post(`${BASE}/api/auth/login`, { data: { loginId: "MF0001-OP", password: PASSWORD } });
let t0 = performance.now();
await page.goto(`${BASE}/dispatch`);
await page.locator('[data-count="expected"]').filter({ hasText: new RegExp(`^${N}$|^\\d{4,}$`) }).waitFor({ timeout: 60_000 });
out.dispatchChecklistLoadMs = Math.round(performance.now() - t0);
out.expectedShown = Number(await page.locator('[data-count="expected"]').innerText());
out.rowsInDom = await page.locator('[data-testid="checklist-row"]').count();
out.domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
const sel = page.getByLabel("Destination");
await sel.selectOption((await sel.locator("option", { hasText: "SS-1" }).getAttribute("value")));
await page.getByLabel("Invoice").fill("INV-PERF");
const heapBefore = await heap();
const uiScan = [];
const input = page.locator("#scan-input");
for (const lot of lots.slice(0, 100)) {
  t0 = performance.now();
  await input.fill(lot);
  await input.press("Enter");
  // Rows past the first page are not in the DOM (paging), so wait for the exact Scanned count instead.
  await page.locator('[data-count="scanned"]').filter({ hasText: new RegExp(`^${uiScan.length + 1}$`) }).waitFor();
  uiScan.push(performance.now() - t0);
}
await page.locator('[data-count="scanned"]').filter({ hasText: /^100$/ }).waitFor();
out.uiScanToScanned = stats(uiScan);
out.apiRequestsFor100Scans = checks;
out.heapMB = { beforeScans: heapBefore, after100Scans: await heap() };
out.domNodesAfter = await page.evaluate(() => document.getElementsByTagName("*").length);
// Search and filter on 1,000 rows
t0 = performance.now();
await page.getByRole("radio", { name: "Pending" }).click();
await page.getByLabel("Find a code in the list").fill(lots[999].slice(-5));
await page.locator(`[data-testid="checklist-row"][data-code="${lots[999]}"]`).waitFor();
out.filterAndSearchMs = Math.round(performance.now() - t0);
await browser.close();

console.log(JSON.stringify(out, null, 2));
if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(out, null, 2));
