// Spec section 9.1 demo script, end to end through the browser UI.

import { expect, test, type Page } from "@playwright/test";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import { PNG } from "pngjs";

let lots: string[] = []; // [OR 00001 case, OR 00002 case, OR 00003 tray, GA 00001 tray]

function decode(buf: Buffer, format: BarcodeFormat): string {
  const png = PNG.sync.read(buf);
  const lum = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < lum.length; i++) lum[i] = (png.data[i * 4] * 299 + png.data[i * 4 + 1] * 587 + png.data[i * 4 + 2] * 114) / 1000;
  const reader = new MultiFormatReader();
  reader.setHints(new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [format]], [DecodeHintType.TRY_HARDER, true]]));
  // ZXing logs every reader it tries before one succeeds; keep the test output readable.
  const saved = [console.log, console.warn, console.error] as const;
  console.log = console.warn = console.error = () => {};
  try {
    return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, png.width, png.height)))).getText();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
}

const STAFF_LOGIN: Record<string, string> = { OPERATOR: "operator", QC: "qc", TRACE_OWNER: "hq", ADMIN: "admin" };
const PASSWORD = "Velza@2026"; // seeded default

/** Sign in as the seeded user for this role (+ partner tag, e.g. "SS-1" → ss1) and open `path`. */
async function as(page: Page, role: string, tag: string | null, path: string) {
  const loginId = tag ? tag.replace("-", "").toLowerCase() : STAFF_LOGIN[role];
  const res = await page.request.post("/api/auth/login", { data: { loginId, password: PASSWORD } });
  expect(res.ok(), `sign in as ${loginId}`).toBe(true);
  await page.goto(path);
}

/** Type a code + Enter like a USB scanner; returns the newest scan-log line. */
async function scan(page: Page, code: string) {
  const items = page.getByTestId("scan-log").locator("li");
  const before = await items.count();
  await page.locator("#scan-input").fill(code);
  await page.locator("#scan-input").press("Enter");
  await expect(items).toHaveCount(before + 1);
  const first = items.first();
  return { ok: (await first.getAttribute("data-ok")) === "true", text: await first.innerText() };
}

async function dispatch(page: Page, role: string, tag: string | null, to: string, invoice: string, codes: string[]) {
  await as(page, role, tag, "/dispatch");
  const sel = page.getByLabel("Destination");
  await sel.selectOption((await sel.locator("option", { hasText: to }).getAttribute("value"))!);
  await page.getByLabel("Invoice").fill(invoice);
  for (const c of codes) expect((await scan(page, c)).ok, `scan ${c}`).toBe(true);
  await page.getByRole("button", { name: /Confirm dispatch/ }).click();
  await expect(page.getByText(new RegExp(`Dispatched ${codes.length} item\\(s\\) to .*${to}.* on ${invoice}`))).toBeVisible();
}

async function receive(page: Page, tag: string, role: string, code: string) {
  await as(page, role, tag, "/receive");
  return scan(page, code);
}

async function verifyLot(page: Page, lotCode: string, packs: string[]) {
  await as(page, "QC", null, "/qc/verify");
  expect((await scan(page, lotCode)).ok).toBe(true);
  for (const p of packs) expect((await scan(page, p)).ok).toBe(true);
  await page.getByRole("button", { name: "Confirm → PACKED" }).click();
  await expect(page.getByText(`Lot ${lotCode} verified → PACKED`)).toBeVisible();
}

const packsOf = (lot: string, type: "CASE" | "TRAY") => (type === "CASE" ? [1, 2, 3, 4].map((s) => `${lot}6${s}`) : [1, 2, 3, 4, 5, 6].map((s) => `${lot}4${s}`));

test.describe.serial("Velza demo script (9.1)", () => {
  const pageErrors: string[] = [];
  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0;
    page.on("pageerror", (e) => pageErrors.push(e.message));
  });
  test.afterEach(() => {
    expect(pageErrors, "uncaught errors in the page").toEqual([]);
  });

  test("0. sign-in required; each role sees only its own portal; SS sees only its distributors", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fusers$/);
    await page.getByLabel("Sign-in ID").fill("ss2");
    await page.getByLabel("Password").fill("wrong-password1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Wrong sign-in ID or password")).toBeVisible();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByText("This page is not part of the Super Stockist portal")).toBeVisible();
    await expect(page.getByTestId("signed-in-user")).toHaveText("Kiran (SS-2)");
    await expect(page.locator("nav")).not.toContainText("Partners");
    expect((await page.request.get("/api/admin/users")).status()).toBe(403);
    expect((await page.request.get("/api/dashboard")).status()).toBe(403);

    await page.goto("/dispatch");
    const options = page.getByLabel("Destination").locator("option");
    await expect(options).toHaveText(["Choose…", "DB-2 Kothrud Distributors (Pune)"]);
    await page.goto("/ss/distributors");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody")).toContainText("DB-2 Kothrud Distributors");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  });

  test("1. operator creates 2 batches; summary 00001–00003 + 00001, 24 stickers; print; barcodes scan back", async ({ page }) => {
    await as(page, "OPERATOR", null, "/operator/new");
    await page.getByRole("spinbutton", { name: "Number of batches", exact: true }).fill("2");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.locator("div.rounded-md", { hasText: "Batch 1" }).getByRole("button", { name: /Original/ }).click();
    await page.locator("div.rounded-md", { hasText: "Batch 2" }).getByRole("button", { name: /Green Apple/ }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Batch 1 cases", exact: true }).fill("2");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Batch 1 trays", exact: true }).fill("1");
    await page.getByRole("spinbutton", { name: "Batch 2 trays", exact: true }).fill("1");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    await expect(page.getByTestId("summary-total-stickers")).toHaveText("24");
    await expect(page.getByTestId("summary-batch-1")).toContainText("00001–00003");
    await expect(page.getByTestId("summary-batch-2")).toContainText("00001");
    await expect(page.getByTestId("summary-stickers-1")).toHaveText("17");
    await expect(page.getByTestId("summary-stickers-2")).toHaveText("7");

    await page.getByRole("button", { name: "Create & print" }).click();
    await page.getByRole("button", { name: "Open print view" }).click();
    const stickers = page.locator(".sticker");
    await expect(stickers).toHaveCount(24);
    lots = await page.locator('.sticker[data-kind="LOT"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-code")!));
    expect(lots).toHaveLength(4);
    expect(lots[0]).toMatch(/^91[A-Z0-9]{6}OR00001$/);
    expect(lots.slice(1, 3).map((l) => l.slice(-5))).toEqual(["00002", "00003"]);
    expect(lots[3]).toMatch(/^91[A-Z0-9]{6}GA00001$/);

    // Every printed barcode and QR decodes back to its code.
    for (let i = 0; i < 24; i++) {
      const el = stickers.nth(i);
      const code = (await el.getAttribute("data-code"))!;
      const bars = await el.locator('[aria-label^="Barcode"]').locator("xpath=..").screenshot({ scale: "device" });
      expect(decode(bars, BarcodeFormat.CODE_128)).toBe(code);
      if ((await el.getAttribute("data-kind")) === "LOT") {
        const qr = await el.locator('[aria-label^="QR"]').locator("xpath=..").screenshot();
        expect(decode(qr, BarcodeFormat.QR_CODE)).toMatch(new RegExp(`/t/${code}$`));
      }
    }
    await page.getByRole("button", { name: /^Print 24 stickers/ }).click();
    await expect(page.getByText("4 lot(s) marked PRINTED")).toBeVisible();
  });

  test("2. supervisor verifies every lot; a pack from another lot is rejected", async ({ page }) => {
    await as(page, "QC", null, "/qc/verify");
    await scan(page, lots[0]);
    const wrong = await scan(page, `${lots[1]}61`);
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toContain("does not belong to lot");
    await page.getByRole("button", { name: "Cancel" }).click();
    await verifyLot(page, lots[0], packsOf(lots[0], "CASE"));
    await verifyLot(page, lots[1], packsOf(lots[1], "CASE"));
    await verifyLot(page, lots[2], packsOf(lots[2], "TRAY"));
    await verifyLot(page, lots[3], packsOf(lots[3], "TRAY"));
  });

  test("3. operator dispatches the 2 Original cases to SS-1 with INV-001", async ({ page }) => {
    await dispatch(page, "OPERATOR", null, "SS-1", "INV-001", [lots[0], lots[1]]);
  });

  test("4. SS-2 receive → WRONG_RECEIVER alert; SS-1 receives both → AT_SS", async ({ page }) => {
    const wrong = await receive(page, "SS-2", "SS", lots[0]);
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toContain("WRONG_RECEIVER");
    for (const c of [lots[0], lots[1]]) {
      const r = await receive(page, "SS-1", "SS", c);
      expect(r.ok).toBe(true);
      expect(r.text).toContain("AT_SS");
    }
    await as(page, "TRACE_OWNER", null, "/hq/alerts");
    await expect(page.getByTestId("alert-row").filter({ hasText: "WRONG_RECEIVER" }).filter({ hasText: lots[0] })).toHaveCount(1);
  });

  test("5. case SS-1 → DB-1 → Supplier-1; open; pack …62 → Outlet-1, received", async ({ page }) => {
    const c = lots[0];
    await dispatch(page, "SS", "SS-1", "DB-1", "INV-002", [c]);
    expect((await receive(page, "DB-1", "DB", c)).text).toContain("AT_DB");
    await dispatch(page, "DB", "DB-1", "Supplier-1", "INV-003", [c]);
    expect((await receive(page, "Supplier-1", "SUPPLIER", c)).text).toContain("AT_SUPPLIER");
    await as(page, "SUPPLIER", "Supplier-1", "/open-lot");
    expect((await scan(page, c)).ok).toBe(true);
    await dispatch(page, "SUPPLIER", "Supplier-1", "Outlet-1", "INV-004", [`${c}62`]);
    const r = await receive(page, "Outlet-1", "OUTLET", `${c}62`);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("AT_OUTLET");
  });

  test("6. HQ search: case timeline shows every step; pack …62 is AT_OUTLET", async ({ page }) => {
    await as(page, "TRACE_OWNER", null, `/hq/search?code=${lots[0]}`);
    const rows = page.getByTestId("timeline-row");
    await expect(rows).toHaveCount(10);
    expect(await rows.locator("td:nth-child(2)").allInnerTexts()).toEqual([
      "GENERATED", "PRINTED", "VERIFIED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "OPENED",
    ]);
    await as(page, "TRACE_OWNER", null, `/hq/search?code=${lots[0]}62`);
    await expect(page.getByTestId("search-result")).toContainText("AT OUTLET");
    await expect(page.getByTestId("search-location")).toContainText("Outlet-1");
  });

  test("7. made-up code → UNKNOWN_CODE; recall Green Apple → RECALLED; public page says Recalled", async ({ page }) => {
    const fake = await receive(page, "SS-1", "SS", "91ZZZZZZOR00001");
    expect(fake.text).toContain("UNKNOWN_CODE");
    const ga = lots[3].slice(2, 8);
    await as(page, "TRACE_OWNER", null, "/hq/batches");
    await page.locator("tr", { hasText: ga }).getByRole("button", { name: "Report" }).click();
    await page.getByPlaceholder(/Quality complaint/).fill("Taste complaint");
    await page.getByRole("button", { name: `Recall batch ${ga}` }).click();
    await page.getByRole("button", { name: /Yes, recall/ }).click();
    await expect(page.getByTestId("recall-report")).toContainText(lots[3]);
    await as(page, "TRACE_OWNER", null, `/hq/search?code=${lots[3]}`);
    await expect(page.getByTestId("search-result")).toContainText("RECALLED");
    await page.goto(`/t/${lots[3]}`);
    await expect(page.getByTestId("public-status")).toContainText("Recalled — do not consume");
    await expect(page.locator("body")).not.toContainText("INV-");
    await page.goto(`/t/${lots[1]}`);
    await expect(page.getByTestId("public-status")).toContainText("Genuine Velza product");
  });

  test("8. device offline: create + verify a batch, dispatch blocked; sync → dispatch works", async ({ page }) => {
    await as(page, "OPERATOR", null, "/operator/new");
    const bar = page.getByTestId("device-bar");
    await bar.getByRole("button", { name: /Online/ }).click();
    await expect(bar.getByRole("button", { name: /Offline/ })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: /No Sugar/ }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Batch 1 cases", exact: true }).fill("1");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/Device is offline/)).toBeVisible();
    await page.getByRole("button", { name: "Create & print" }).click();
    await expect(page.getByText(/offline — unsynced/)).toBeVisible();
    await page.getByRole("button", { name: "Open print view" }).click();
    const lot = (await page.locator(".sticker").first().getAttribute("data-code"))!;
    await page.getByRole("button", { name: /^Print 5 stickers/ }).click();
    await expect(page.getByText("1 lot(s) marked PRINTED")).toBeVisible();
    await verifyLot(page, lot, packsOf(lot, "CASE"));

    await as(page, "OPERATOR", null, "/dispatch");
    const sel = page.getByLabel("Destination");
    await sel.selectOption((await sel.locator("option", { hasText: "SS-1" }).getAttribute("value"))!);
    await page.getByLabel("Invoice").fill("INV-009");
    const blocked = await scan(page, lot);
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain("UNSYNCED");
    await expect(bar.getByRole("button", { name: "Sync" })).toBeDisabled();
    await bar.getByRole("button", { name: /Offline/ }).click();
    await bar.getByRole("button", { name: "Sync" }).click();
    await expect(bar).toContainText("Synced 1 batch(es) and 1 lot(s)");
    expect((await scan(page, lot)).ok).toBe(true);
    await page.getByRole("button", { name: /Confirm dispatch/ }).click();
    await expect(page.getByText(/Dispatched 1 item\(s\) to .*SS-1.* on INV-009/)).toBeVisible();
  });

  test("9. reprint a sticker → same code, logged with reason", async ({ page }) => {
    const code = `${lots[2]}43`;
    await as(page, "OPERATOR", null, "/operator/reprint");
    await page.locator("#scan-input").fill(code);
    await page.locator("#scan-input").press("Enter");
    await page.getByPlaceholder(/Sticker torn/).fill("Sticker torn while pasting");
    await page.getByRole("button", { name: "Log reprint" }).click();
    await expect(page.getByText(`Reprint of ${code} logged (same code)`)).toBeVisible();
    await expect(page.locator("tbody tr").first()).toContainText("Sticker torn while pasting");
    await page.getByRole("link", { name: `Open print view for ${code}` }).click();
    await expect(page.locator(".sticker")).toHaveCount(1);
    await expect(page.locator(".sticker")).toHaveAttribute("data-code", code);
    await expect(page.locator(".sticker")).toContainText("PACK 3 of 6 | 4 CANS");
  });
});
