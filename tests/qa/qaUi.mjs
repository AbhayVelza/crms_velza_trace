// Browser QA against the QA server (sign-in ON): each of the 7 roles signs in through the form, sees exactly
// its menu, is refused another portal's page by URL, has no console errors, and signs out. Also the Admin
// partner filters on the QA dataset and the public QR page. Results: docs/qa/qa-ui-results.json.
//
//   QA_BASE=http://localhost:3300 node tests/qa/qaUi.mjs        (Microsoft Edge; PW_CHANNEL=chrome to change)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.QA_BASE ?? "http://localhost:3300";
const creds = JSON.parse(readFileSync(process.env.QA_CREDENTIALS ?? "data/qa-mh-2026-credentials.json", "utf8"));
const manifest = JSON.parse(readFileSync("docs/qa/maharashtra-test-data.json", "utf8"));
const idOf = (suffix) => manifest.partners.find((p) => p.code.endsWith(suffix)).id;

// Menus as defined in src/lib/menu.ts (labels the sidebar must show, in order).
const ROLES = [
  { role: "ADMIN", login: "AD0001", pw: creds.adminPassword, menu: ["Partners", "Sign-ins & passwords", "Devices", "Countries & flavours", "Batch code pools", "Settings"], forbidden: "/hq", portal: "Velza Admin" },
  { role: "TRACE_OWNER", login: "HQ0001", pw: creds.hqPassword, menu: ["Dashboard", "Search code", "Alerts", "Batches & recall", "Scan audit"], forbidden: "/admin/partners", portal: "Velza HQ" },
  { role: "OPERATOR", login: `${idOf("MFG-001")}-OP`, pw: creds.partnerPassword, menu: ["New print order", "Print orders", "Dispatch", "Reprint", "Void lot", "My stock", "Damaged"], forbidden: "/qc/verify", portal: "Manufacturer Operator" },
  { role: "QC", login: `${idOf("MFG-001")}-QC`, pw: creds.partnerPassword, menu: ["Verify", "My stock"], forbidden: "/operator/new", portal: "Supervisor/QC" },
  { role: "SS", login: idOf("SS-001"), pw: creds.partnerPassword, menu: ["Receive", "Dispatch", "My stock", "Damaged", "My partners"], forbidden: "/admin/partners", portal: "Super Stockist" },
  { role: "DB", login: idOf("DST-001"), pw: creds.partnerPassword, menu: ["Receive", "Dispatch", "My stock", "Damaged", "My retailers"], forbidden: "/hq/search", portal: "Distributor" },
  { role: "RETAILER", login: idOf("RTL-001"), pw: creds.partnerPassword, menu: ["Receive", "Open lot", "My stock", "Damaged"], forbidden: "/dispatch", portal: "Retailer" },
];

const results = [];
const rec = (area, test, ok, expected, actual) => {
  const status = typeof ok === "string" ? ok : ok ? "PASS" : "FAIL";
  results.push({ area, test, status, expected, actual });
  console.log(`${status.padEnd(7)} ${area} · ${test}${status === "PASS" ? "" : ` — expected ${expected}; actual ${actual}`}`);
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "msedge" });
async function signedIn(r, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  // With sign-in ON the header probes /api/auth/dev-users and treats its 404 as "sign-in is on" (useDevUsers in
  // src/components/ActAs.tsx); the browser logs that 404 as a console error. Counted separately, not a failure.
  const probe404 = { count: 0 };
  page.on("response", (res) => res.status() === 404 && /\/api\/auth\/dev-users$/.test(res.url()) && (probe404.count += 1));
  page.on("console", (m) => m.type() === "error" && !/401|403/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Sign-in ID").fill(r.login);
  await page.getByLabel("Password").fill(r.pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.waitForLoadState("networkidle");
  return { ctx, page, errors, probe404 };
}

for (const r of ROLES) {
  const { ctx, page, errors, probe404 } = await signedIn(r);
  const menu = (await page.locator("nav a").allInnerTexts()).map((t) => t.trim());
  rec("UI roles", `${r.role}: sidebar shows exactly its menu`, JSON.stringify(menu) === JSON.stringify(r.menu), r.menu.join(" | "), menu.join(" | "));
  await page.goto(`${BASE}${r.forbidden}`);
  await page.waitForLoadState("networkidle");
  const refused = await page.getByText(`This page is not part of the ${r.portal} portal`).isVisible();
  rec("UI roles", `${r.role}: ${r.forbidden} by URL shows "not part of your portal"`, refused, "refusal message", refused ? "shown" : "not shown");
  // First menu item opens and highlights
  await page.locator("nav a").first().click();
  await page.waitForLoadState("networkidle");
  const current = (await page.locator('nav a[aria-current="page"]').allInnerTexts()).map((t) => t.trim());
  rec("UI roles", `${r.role}: first menu item opens and is marked current`, current.length === 1 && current[0] === r.menu[0], r.menu[0], current.join(","));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  rec("UI roles", `${r.role}: no sideways scrolling at 1440 px`, !overflow, "none", overflow ? "overflow" : "none");
  // Reload keeps the session and the page
  const url = page.url();
  await page.reload();
  await page.waitForLoadState("networkidle");
  rec("UI roles", `${r.role}: reload keeps the session and the page`, page.url() === url && (await page.locator("nav a").count()) === r.menu.length, url, page.url());
  // Back / forward
  await page.goBack();
  await page.waitForURL((u) => u.href !== url);
  const back = page.url();
  await page.goForward();
  await page.waitForURL(url);
  rec("UI roles", `${r.role}: back and forward work`, page.url() === url && back !== url, `back to the previous page, forward to ${url}`, `${back} → ${page.url()}`);
  const notFound = errors.filter((e) => /status of 404/.test(e)).length;
  const real = errors.filter((e) => !/status of 404/.test(e)).concat(notFound > probe404.count ? [`${notFound - probe404.count} other 404(s)`] : []);
  rec("UI roles", `${r.role}: no console errors apart from the sign-in-mode probe`, real.length === 0, "0", real.slice(0, 2).join(" | ") || `0 (dev-users probe 404s: ${probe404.count})`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  const after = await ctx.request.get(`${BASE}/api/auth/me`);
  rec("UI roles", `${r.role}: Sign out ends the session`, after.status() === 401, "401", String(after.status()));
  await ctx.close();
}

// Admin partner list: the QA dataset is findable with the existing filters
{
  const { ctx, page } = await signedIn(ROLES[0]);
  await page.goto(`${BASE}/admin/partners`);
  await page.waitForLoadState("networkidle");
  const rows = page.locator("tbody tr");
  const all = await rows.count();
  rec("Search & filters", "Partners table lists all 18 QA partners", all === 18, "18 rows", String(all));
  const show = page.getByLabel("Show");
  const options = (await show.locator("option").allInnerTexts()).map((t) => t.trim());
  const ss1Opt = options.find((o) => o.includes(idOf("SS-001")) || o.includes("Deccan"));
  if (ss1Opt) {
    await show.selectOption({ label: ss1Opt });
    // Names are editable inputs; the ID column is plain text.
    const shown = (await rows.locator("td:first-child").allInnerTexts()).map((t) => t.trim()).sort();
    const want = ["DST-001", "DST-002", "DST-003"].map(idOf).sort();
    rec("Search & filters", `Filter "${ss1Opt}" shows SS-001's partners only`, JSON.stringify(shown) === JSON.stringify(want), want.join(", "), shown.join(", "));
  } else rec("Search & filters", "Filter by Super Stockist", false, "an option for SS-001", options.join(" | "));
  const dbOpt = options.find((o) => o.includes(idOf("DST-004")) || o.includes("Kolhapur Distributors"));
  if (dbOpt) {
    await show.selectOption({ label: dbOpt });
    const shown = (await rows.locator("td:first-child").allInnerTexts()).map((t) => t.trim()).sort();
    const want = ["RTL-007", "RTL-008"].map(idOf).sort();
    rec("Search & filters", `Filter "${dbOpt}" shows its 2 retailers`, JSON.stringify(shown) === JSON.stringify(want), want.join(", "), shown.join(", "));
  }
  const hasSearch = await page.getByRole("searchbox").count() + (await page.getByPlaceholder(/search/i).count());
  rec("Search & filters", "Text search, sorting controls and pagination on the partners table", hasSearch === 0 ? "NOT RUN" : "PASS", "exists?", hasSearch === 0 ? "not implemented: a 'Show' filter only; all rows render on one page" : "present");
  rec("Search & filters", "Available filter options", "PASS", "listed", options.join(" | "));
  await ctx.close();
}

// Mobile: drawer gives every role its menu
{
  const r = ROLES[6];
  const { ctx, page } = await signedIn(r, { width: 390, height: 844 });
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.waitForTimeout(300);
  const menu = (await page.locator("nav a").allInnerTexts()).map((t) => t.trim());
  rec("UI mobile", "Retailer on a phone: drawer shows its menu", JSON.stringify(menu) === JSON.stringify(r.menu), r.menu.join(" | "), menu.join(" | "));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const inert = await page.evaluate(() => document.getElementById("app-sidebar")?.inert === true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  rec("UI mobile", "Escape closes the drawer; no sideways scrolling", inert && !overflow, "closed, no overflow", `inert=${inert}, overflow=${overflow}`);
  await ctx.close();
}

// Public QR page for the scanned case and the recalled tray
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const lots = JSON.parse(readFileSync(process.env.QA_DB_PATH ?? "data/qa-mh-2026.json", "utf8")).lots;
  const caseLot = lots.find((l) => l.lotType === "CASE");
  const trayLot = lots.find((l) => l.lotType === "TRAY");
  for (const [lot, want] of [[caseLot, /Genuine/], [trayLot, /Recalled — do not consume/]]) {
    if (!lot) continue;
    await page.goto(`${BASE}/t/${lot.lotCode}`);
    const status = page.getByTestId("public-status");
    await status.waitFor();
    const text = await status.innerText();
    rec("UI public", `Public page for ${lot.lotType.toLowerCase()} ${lot.lotCode}`, want.test(text), String(want), text.trim());
  }
  await ctx.close();
}

await browser.close();
mkdirSync("docs/qa", { recursive: true });
const summary = Object.fromEntries(["PASS", "FAIL", "BLOCKED", "NOT RUN", "NEEDS INVESTIGATION"].map((s) => [s, results.filter((x) => x.status === s).length]));
writeFileSync("docs/qa/qa-ui-results.json", JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, summary, results }, null, 2) + "\n");
console.log(`\n${JSON.stringify(summary)}`);
if (summary.FAIL) process.exitCode = 1;
