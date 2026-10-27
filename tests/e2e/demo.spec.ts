// Spec section 9.1 demo script, end to end through the browser UI.

import { expect, test, type Page } from "@playwright/test";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import { PNG } from "pngjs";

let lots: string[] = []; // [OR 00001 case, OR 00002 case, OR 00003 tray, GA 00001 tray]
let offlineLot = ""; // the No Sugar case made while the device was offline (step 8)

/** Average f×f blocks: the same picture at 1/f the size. */
function shrink(lum: Uint8ClampedArray, w: number, h: number, f: number) {
  const W = Math.floor(w / f);
  const H = Math.floor(h / f);
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += lum[(y * f + dy) * w + x * f + dx];
      out[y * W + x] = sum / (f * f);
    }
  }
  return { lum: out, w: W, h: H };
}

/**
 * Decode a screenshot with ZXing. ZXing misses about 1 in 40 valid QR symbols at one particular pixel size
 * (they decode at others, and in other readers), so a miss is retried at half and a third of the size —
 * as a phone camera sees the sticker at many sizes.
 */
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
    let lastError: unknown;
    for (const f of [1, 2, 3]) {
      const img = f === 1 ? { lum, w: png.width, h: png.height } : shrink(lum, png.width, png.height, f);
      try {
        return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(img.lum, img.w, img.h)))).getText();
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
}

const PASSWORD = "Sample2026pass"; // every sample sign-in (tests/fixtures/sampleNetwork.ts)
const PREFIX: Record<string, string> = { SS: "SS", DB: "DB", RETAILER: "RT" };

/** Sign-in ID of a sample person: AD0001, HQ0001, MF0001-OP, MF0001-QC, or the partner ID ("SS-2" → SS0002). */
function loginIdOf(role: string, tag: string | null): string {
  if (role === "ADMIN") return "AD0001";
  if (role === "TRACE_OWNER") return "HQ0001";
  if (role === "OPERATOR") return "MF0001-OP";
  if (role === "QC") return "MF0001-QC";
  return `${PREFIX[role]}${tag!.match(/(\d+)$/)![1].padStart(4, "0")}`;
}

/** Act as the sample user for this role (+ partner tag in the name, e.g. "SS-1") and open `path`. */
async function as(page: Page, role: string, tag: string | null, path: string) {
  const res = await page.request.post("/api/auth/login", { data: { loginId: loginIdOf(role, tag), password: PASSWORD } });
  expect(res.status(), `sign in as ${loginIdOf(role, tag)}`).toBe(200);
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
    // The Content Security Policy must not block anything the app itself needs.
    page.on("console", (m) => /Content Security Policy|Refused to (load|execute|connect|apply|frame)/.test(m.text()) && pageErrors.push(m.text()));
  });
  test.afterEach(() => {
    expect(pageErrors, "uncaught errors in the page").toEqual([]);
  });

  test("0. each role sees only its own portal; SS and DB see only their assigned partners", async ({ page }) => {
    await as(page, "SS", "SS-2", "/admin/users");
    await expect(page.getByText("This page is not part of the Super Stockist portal")).toBeVisible();
    await expect(page.locator("nav")).not.toContainText("Partners");
    // Signed in as SS0002: the API refuses the Admin and HQ data too, not just the menu.
    expect((await page.request.get("/api/admin/users")).status()).toBe(403);
    expect((await page.request.get("/api/dashboard")).status()).toBe(403);

    await page.goto("/dispatch");
    await expect(page.getByLabel("Destination").locator("option")).toHaveText(["Choose…", "DB-2 Kothrud Distributors (Pune)"]);
    await page.goto("/my-partners");
    await expect(page.getByRole("heading", { name: "My distributors and retailers" })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody")).toContainText("DB-2 Kothrud Distributors");

    // SS-1: its distributor and the retailer it supplies directly — not its distributor's retailers
    await as(page, "SS", "SS-1", "/dispatch");
    await expect(page.getByLabel("Destination").locator("option")).toHaveText(["Choose…", "DB-1 Thane Distributors (Thane)", "Retailer-4 Colaba Kirana (Mumbai)"]);
    await page.goto("/my-partners");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator("tbody")).toContainText("Retailer-4 Colaba Kirana");
    await expect(page.locator("tbody")).not.toContainText("Retailer-1");

    // Same for the Distributors: DB-2 → only Retailer-3, DB-1 → only Retailer-1 and Retailer-2
    await as(page, "DB", "DB-2", "/dispatch");
    await expect(page.getByLabel("Destination").locator("option")).toHaveText(["Choose…", "Retailer-3 Aundh Cafe (Pune)"]);
    await as(page, "DB", "DB-1", "/my-partners");
    await expect(page.getByRole("heading", { name: "My retailers" })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator("tbody")).not.toContainText("Retailer-3");
    await expect(page.locator("tbody")).not.toContainText("Retailer-4");
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
    // Every generated code is listed with all its fields, with the sticker total and sync status.
    await expect(page.getByTestId("code-row")).toHaveCount(24);
    await expect(page.getByTestId("code-totals")).toContainText("Synced24 / 24");
    await page.getByRole("button", { name: "Open print view" }).click();
    const stickers = page.locator(".sticker");
    await expect(stickers).toHaveCount(24);
    lots = await page.locator('.sticker[data-kind="LOT"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-code")!));
    expect(lots).toHaveLength(4);
    expect(lots[0]).toMatch(/^91[A-Z0-9]{6}OR00001$/);
    expect(lots.slice(1, 3).map((l) => l.slice(-5))).toEqual(["00002", "00003"]);
    expect(lots[3]).toMatch(/^91[A-Z0-9]{6}GA00001$/);

    // Every printed barcode and QR decodes back to its code. A screenshot taken while the page is still
    // scrolling or laying out can come back blurred, so each one gets up to 3 captures; a real misprint fails all 3.
    const decodeShot = async (target: ReturnType<Page["locator"]>, format: BarcodeFormat, what: string, scale?: "device") => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return decode(await target.screenshot(scale ? { scale } : {}), format);
        } catch (e) {
          lastError = e;
          await page.waitForTimeout(300);
        }
      }
      throw new Error(`${what} did not decode after 3 captures: ${lastError}`);
    };
    for (let i = 0; i < 24; i++) {
      const el = stickers.nth(i);
      const code = (await el.getAttribute("data-code"))!;
      const bars = el.locator('[aria-label^="Barcode"]').locator("xpath=..");
      expect(await decodeShot(bars, BarcodeFormat.CODE_128, `Barcode ${code}`, "device")).toBe(code);
      if ((await el.getAttribute("data-kind")) === "LOT") {
        const qr = el.locator('[aria-label^="QR"]').locator("xpath=..");
        expect(await decodeShot(qr, BarcodeFormat.QR_CODE, `QR ${code}`, "device")).toMatch(new RegExp(`/t/${code}$`));
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

  test("5. case SS-1 → DB-1 → Retailer-1, who opens it; case SS-1 → Retailer-4 directly", async ({ page }) => {
    const c = lots[0];
    await dispatch(page, "SS", "SS-1", "DB-1", "INV-002", [c]);
    expect((await receive(page, "DB-1", "DB", c)).text).toContain("AT_DB");
    await dispatch(page, "DB", "DB-1", "Retailer-1", "INV-003", [c]);
    expect((await receive(page, "Retailer-1", "RETAILER", c)).text).toContain("AT_RETAILER");
    await as(page, "RETAILER", "Retailer-1", "/open-lot");
    expect((await scan(page, c)).ok).toBe(true);
    // The Retailer is the last tier: it has no Dispatch screen
    await page.goto("/dispatch");
    await expect(page.getByText("This page is not part of the Retailer portal")).toBeVisible();

    // A few retailers are supplied by their Super Stockist directly
    await dispatch(page, "SS", "SS-1", "Retailer-4", "INV-004", [lots[1]]);
    const r = await receive(page, "Retailer-4", "RETAILER", lots[1]);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("AT_RETAILER");
  });

  test("6. HQ search: case timeline shows every step; pack …62 is AT_RETAILER; the direct case is at Retailer-4", async ({ page }) => {
    await as(page, "TRACE_OWNER", null, `/hq/search?code=${lots[0]}`);
    const rows = page.getByTestId("timeline-row");
    await expect(rows).toHaveCount(10);
    expect(await rows.locator("td:nth-child(2)").allInnerTexts()).toEqual([
      "GENERATED", "PRINTED", "VERIFIED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "DISPATCHED", "RECEIVED", "OPENED",
    ]);
    await as(page, "TRACE_OWNER", null, `/hq/search?code=${lots[0]}62`);
    await expect(page.getByTestId("search-result")).toContainText("AT RETAILER");
    await expect(page.getByTestId("search-location")).toContainText("Retailer-1");
    await as(page, "TRACE_OWNER", null, `/hq/search?code=${lots[1]}`);
    await expect(page.getByTestId("search-result")).toContainText("AT RETAILER");
    await expect(page.getByTestId("search-location")).toContainText("Retailer-4");
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
    const lot = (offlineLot = (await page.locator(".sticker").first().getAttribute("data-code"))!);
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

  test("10. SS-1 receives the synced case and reports it damaged → it leaves stock, shows in Damaged, HQ is alerted", async ({ page }) => {
    expect((await receive(page, "SS-1", "SS", offlineLot)).text).toContain("AT_SS");
    await as(page, "SS", "SS-1", "/damaged");
    await expect(page.locator("#scan-input")).toBeDisabled(); // reason first
    await page.getByRole("button", { name: "Crushed / dented" }).click();
    const r = await scan(page, offlineLot);
    expect(r.ok, r.text).toBe(true);
    await expect(page.getByTestId("damaged-row")).toHaveCount(1);
    await expect(page.getByTestId("damaged-row")).toContainText("Crushed / dented");
    await expect(page.getByTestId("damaged-counts")).toContainText(/1s*Cases/);

    await as(page, "TRACE_OWNER", null, "/hq/alerts");
    await expect(page.getByTestId("alert-row").filter({ hasText: "DAMAGED" }).filter({ hasText: offlineLot })).toHaveCount(1);
    await page.goto("/hq");
    await expect(page.getByRole("row", { name: /^Super Stockist SS-1/ })).toContainText("1 case");
  });

  test("11. Admin registers a distributor and a retailer under SS-1 directly; the sign-in works, sees only its portal, changes its password", async ({ page }) => {
    await as(page, "ADMIN", null, "/admin/partners");
    const form = page.locator("section", { hasText: "Register a partner" });
    await form.getByLabel("Tier", { exact: true }).selectOption("DB");
    await form.getByLabel("Site name").fill("FC Road Distributors");
    await form.getByLabel("Contact person").fill("Asha Patil");
    await form.getByLabel("Place").fill("FC Road");
    await form.getByLabel("Address").fill("Shop 12, FC Road");
    await form.getByLabel("City").fill("Pune");
    await form.getByLabel("State").selectOption("Maharashtra");
    await form.getByLabel("PIN code").fill("411004");
    await form.getByLabel("Phone").fill("+91 98765 43210");
    await expect(form.getByLabel("Assigned to tier")).toHaveCount(0); // a Distributor is always assigned to a Super Stockist
    await form.getByLabel("Assigned to", { exact: true }).selectOption("SS0001");
    await form.getByLabel("Sign-in password").fill("Fresh2026pass");
    await form.getByRole("button", { name: "Register" }).click();
    await expect(page.getByTestId("register-result")).toHaveText("Registered FC Road Distributors as DB0003 — sign-in DB0003");

    // A Retailer is assigned to a Distributor, or (for a few) to its Super Stockist directly.
    await form.getByLabel("Tier", { exact: true }).selectOption("RETAILER");
    await form.getByLabel("Site name").fill("Camp Kirana");
    await form.getByLabel("Contact person").fill("Ravi Shah");
    await form.getByLabel("Place").fill("Camp");
    await form.getByLabel("Address").fill("7 MG Road, Camp");
    await form.getByLabel("City").fill("Pune");
    await form.getByLabel("State").selectOption("Maharashtra");
    await form.getByLabel("Phone").fill("+91 98765 43211");
    await form.getByLabel("Assigned to tier").selectOption("SS");
    await form.getByLabel("Assigned to", { exact: true }).selectOption("SS0001");
    await form.getByLabel("Sign-in password").fill("Kirana2026pass");
    await form.getByRole("button", { name: "Register" }).click();
    await expect(page.getByTestId("register-result")).toHaveText("Registered Camp Kirana as RT0005 — sign-in RT0005");
    // SS-1 can now supply it; DB-1 can't.
    await as(page, "SS", "SS-1", "/dispatch");
    await expect(page.getByLabel("Destination").locator("option", { hasText: "Camp Kirana" })).toHaveCount(1);
    await as(page, "DB", "DB-1", "/dispatch");
    await expect(page.getByLabel("Destination").locator("option", { hasText: "Camp Kirana" })).toHaveCount(0);

    // The person signs in on the sign-in page with what the Admin shared.
    await page.context().clearCookies();
    await page.goto("/dispatch");
    await expect(page).toHaveURL(/\/login\?next=%2Fdispatch$/);
    await page.getByLabel("Sign-in ID").fill("db0003");
    await page.getByLabel("Password").fill("wrong-pass1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Wrong sign-in ID or password")).toBeVisible();
    await page.getByLabel("Password").fill("Fresh2026pass");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dispatch$/);
    await expect(page.getByTestId("signed-in-user")).toHaveText("Asha Patil");
    await page.goto("/admin/partners");
    await expect(page.getByText("This page is not part of the Distributor portal")).toBeVisible();

    await page.goto("/account");
    await page.getByLabel("Current password").fill("Fresh2026pass");
    await page.getByLabel(/^New password/).fill("Mine2026pass");
    await page.getByLabel("Repeat new password").fill("Mine2026pass");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
