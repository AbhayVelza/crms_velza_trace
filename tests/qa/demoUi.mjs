// Browser check of the management-demo environment (sign-in ON, data built by tests/qa/demoSetup.ts).
// Every demo role signs in through the form and opens every page of its menu at 4 widths; each page must have a
// title, no page/console errors, no sideways scrolling, no raw internal error text and no dev-only controls.
// Also: refusal of another portal by URL, keyboard focus, the print-pending and trace pages, the public page,
// sign-out. Never runs against port 3000.
//
//   DEMO_BASE=http://127.0.0.1:3400 DEMO_CREDENTIALS=<demo>/demo-credentials.json DEMO_DB_PATH=<demo>/data/demo.json \
//     DEMO_EVIDENCE=<demo>/evidence node tests/qa/demoUi.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.DEMO_BASE ?? "http://127.0.0.1:3400";
if (/:3000\b/.test(BASE)) throw new Error("Refusing to run against port 3000");
const creds = JSON.parse(readFileSync(process.env.DEMO_CREDENTIALS, "utf8"));
const db = JSON.parse(readFileSync(process.env.DEMO_DB_PATH, "utf8"));
const OUT = process.env.DEMO_EVIDENCE ?? "evidence";
const byName = (prefix) => db.partners.find((p) => p.name.startsWith(prefix)).id;
const MF = byName("DEMO-Manufacturer");

const ROLES = [
  { role: "ADMIN", login: "AD0001", pw: creds.adminPassword, portal: "Velza Admin", forbidden: "/hq", pages: ["/admin/partners", "/admin/users", "/admin/devices", "/admin/reference", "/admin/pools", "/admin/settings"] },
  { role: "HQ", login: "HQ0001", pw: creds.hqPassword, portal: "Velza HQ", forbidden: "/admin/partners", pages: ["/hq", "/hq/search", "/hq/alerts", "/hq/batches", "/hq/scans"] },
  { role: "OPERATOR", login: `${MF}-OP`, pw: creds.partnerPassword, portal: "Manufacturer Operator", forbidden: "/qc/verify", pages: ["/operator/new", "/operator/orders", "/dispatch", "/operator/reprint", "/operator/void", "/stock", "/damaged"] },
  { role: "QC", login: `${MF}-QC`, pw: creds.partnerPassword, portal: "Supervisor/QC", forbidden: "/operator/new", pages: ["/qc/verify", "/stock"] },
  { role: "SS", login: byName("DEMO-SuperStockist"), pw: creds.partnerPassword, portal: "Super Stockist", forbidden: "/admin/partners", pages: ["/receive", "/dispatch", "/stock", "/damaged", "/my-partners"] },
  { role: "DB", login: byName("DEMO-Distributor Mumbai"), pw: creds.partnerPassword, portal: "Distributor", forbidden: "/hq/search", pages: ["/receive", "/dispatch", "/stock", "/damaged", "/my-partners"] },
  { role: "RETAILER", login: byName("DEMO-Retailer Andheri"), pw: creds.partnerPassword, portal: "Retailer", forbidden: "/dispatch", pages: ["/receive", "/open-lot", "/stock", "/damaged"] },
];
const WIDTHS = [
  [1440, 900],
  [1366, 768],
  [768, 1024],
  [390, 844],
];
const RAW_ERROR = /(TypeError|ReferenceError|Unhandled|stack trace|\bat \S+ \([^)]*:\d+:\d+\)|ENOENT|ECONNREFUSED|Internal Server Error|undefined is not|\bNaN\b|\[object Object\])/;

const results = [];
let expected401 = 0;
const rec = (area, test, ok, detail = "") => {
  const status = ok ? "PASS" : "FAIL";
  results.push({ area, test, status, detail });
  if (!ok) console.log(`FAIL  ${area} · ${test} — ${detail}`);
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "msedge" });

async function signIn(r, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  // The sign-in page asks /api/auth/me whether a session exists; its 401 there is expected (documented), not an error.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (new URL(page.url()).pathname === "/login" && /status of 401/.test(m.text())) return void expected401++;
    errors.push(`${page.url()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Sign-in ID").fill(r.login);
  await page.getByLabel("Password").fill(r.pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.waitForLoadState("networkidle");
  return { ctx, page, errors };
}

async function pageCheck(page, r, url, w) {
  await page.goto(`${BASE}${url}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    h1: document.querySelector("main h1, h1")?.textContent?.trim() ?? "",
    text: document.querySelector("main")?.innerText ?? document.body.innerText,
    demo: !!document.querySelector("[data-demo-code]") || /Demo helper/i.test(document.body.innerText),
    busy: !!document.querySelector('[aria-busy="true"]'),
  }));
  const tag = `${r.role} ${url} @${w}px`;
  rec("Pages", `${tag}: has a title`, info.h1.length > 0, info.h1 || "no h1");
  rec("Pages", `${tag}: not blank`, info.text.trim().length > 40, `${info.text.trim().length} chars`);
  rec("Pages", `${tag}: no sideways scrolling`, info.overflow <= 1, `${info.overflow}px wider than the window`);
  rec("Pages", `${tag}: no raw internal error text`, !RAW_ERROR.test(info.text), (info.text.match(RAW_ERROR) ?? [""])[0]);
  rec("Pages", `${tag}: no development-only controls`, !info.demo, "demo helper visible");
  rec("Pages", `${tag}: finished loading`, !info.busy, "still busy");
}

for (const r of ROLES) {
  for (const [w, h] of WIDTHS) {
    const { ctx, page, errors } = await signIn(r, { width: w, height: h });
    for (const url of r.pages) await pageCheck(page, r, url, w);
    if (w === 1440) {
      await page.goto(`${BASE}${r.forbidden}`);
      await page.waitForLoadState("networkidle");
      rec("Access", `${r.role}: ${r.forbidden} by URL is refused`, await page.getByText(`This page is not part of the ${r.portal} portal`).isVisible(), "no refusal shown");
      await page.goto(`${BASE}${r.pages[0]}`);
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        return { tag: el.tagName, visible: s.outlineStyle !== "none" || s.boxShadow !== "none" };
      });
      rec("Keyboard", `${r.role}: Tab moves focus to a control with a visible focus style`, !!focus && focus.visible, JSON.stringify(focus));
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForURL(/\/login/);
      rec("Access", `${r.role}: sign-out ends the session`, (await ctx.request.get(`${BASE}/api/auth/me`)).status() === 401, "");
    }
    rec("Console", `${r.role} @${w}px: no console or page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
}

// Workflow pages the demo script shows
{
  const op = ROLES[2];
  const { ctx, page, errors } = await signIn(op, { width: 1440, height: 900 });
  const pending = db.printOrders.find((o) => o.status === "CREATED");
  const printed = db.printOrders.find((o) => o.status === "PRINTED");
  await page.goto(`${BASE}/operator/orders`);
  await page.waitForLoadState("networkidle");
  rec("Workflow", "Print orders: pending order shows PRINTING PENDING and Finish printing", (await page.getByText("PRINTING PENDING", { exact: true }).count()) === 1 && (await page.locator(`a[href="/print/${pending.id}"]`).innerText()).includes("Finish printing"));
  await page.goto(`${BASE}/print/${pending.id}`);
  await page.waitForLoadState("networkidle");
  rec("Workflow", "Pending print view: status, Mark as printed and the Ctrl+P/CSV note", (await page.getByText("PRINTING PENDING", { exact: true }).isVisible()) && (await page.getByRole("button", { name: "Mark as printed" }).isVisible()) && (await page.getByText(/neither do Ctrl\+P or downloading the codes CSV/).isVisible()));
  await page.goto(`${BASE}/print/${printed.id}`);
  await page.waitForLoadState("networkidle");
  rec("Workflow", "Printed print view: PRINTED with time, no Mark as printed", (await page.getByText("PRINTED", { exact: true }).isVisible()) && (await page.getByText(/^Printed \S/).isVisible()) && (await page.getByRole("button", { name: "Mark as printed" }).count()) === 0);
  rec("Console", "Operator print pages: no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
{
  const hq = ROLES[1];
  const { ctx, page, errors } = await signIn(hq, { width: 1440, height: 900 });
  const opened = db.lots.find((l) => l.status === "OPENED");
  await page.goto(`${BASE}/hq/search`);
  await page.waitForLoadState("networkidle");
  await page.locator("#scan-input").fill(opened.lotCode);
  await page.locator("#scan-input").press("Enter");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  const text = await page.locator("main").innerText();
  rec("Workflow", "HQ search of the opened case shows its retailer and full timeline", /OPENED/.test(text) && /DISPATCHED/.test(text) && /VERIFIED/.test(text) && text.includes("Andheri"), text.slice(0, 200));
  rec("Console", "HQ search: no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const packed = db.lots.find((l) => l.status === "AT_RETAILER");
  await page.goto(`${BASE}/t/${packed.lotCode}`);
  const status = page.getByTestId("public-status");
  await status.waitFor();
  rec("Workflow", "Public QR page says Genuine for a delivered case", /Genuine/.test(await status.innerText()), await status.innerText());
  const body = await page.locator("body").innerText();
  rec("Security", "Public QR page shows no partner names or invoices", !/DEMO-|INV-/.test(body), body.slice(0, 200));
  await ctx.close();
}

await browser.close();
mkdirSync(OUT, { recursive: true });
const summary = { PASS: results.filter((x) => x.status === "PASS").length, FAIL: results.filter((x) => x.status === "FAIL").length, expectedSignInPage401: expected401 };
writeFileSync(path.join(OUT, "demo-ui-results.json"), JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, summary, results }, null, 2) + "\n");
console.log(`\n${JSON.stringify(summary)}`);
if (summary.FAIL) process.exitCode = 1;
