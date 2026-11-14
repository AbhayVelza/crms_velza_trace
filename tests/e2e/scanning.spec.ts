// Scanning in the browser: keyboard-wedge scanner, manual entry, the camera (Chromium's fake capture device playing a
// generated video of a real Code 128 barcode, decoded by @zxing/browser — an emulated camera, not physical hardware),
// and the live checklists on QC Verify, Dispatch and Receive. Runs after demo.spec.ts on the same e2e server.

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import bwipjs from "bwip-js/node";
import { PNG } from "pngjs";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = "Sample2026pass"; // every sample sign-in (tests/fixtures/sampleNetwork.ts)
const FAKE_CAMERA = path.join(os.tmpdir(), "velza-e2e", "fake-camera.y4m");
const W = 640;
const H = 480;

/** Writes a Y4M video (what Chromium's fake camera plays, in a loop) showing one Code 128 barcode on white. */
async function showOnCamera(code: string) {
  const png = PNG.sync.read(await bwipjs.toBuffer({ bcid: "code128", text: code, scale: 2, height: 18, backgroundcolor: "FFFFFF", paddingwidth: 12, paddingheight: 12 }));
  const y = Buffer.alloc(W * H, 235);
  const ox = Math.max(0, Math.floor((W - png.width) / 2));
  const oy = Math.max(0, Math.floor((H - png.height) / 2));
  for (let r = 0; r < Math.min(png.height, H); r++)
    for (let c = 0; c < Math.min(png.width, W); c++) {
      const i = (r * png.width + c) * 4;
      y[(oy + r) * W + ox + c] = Math.round(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]);
    }
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma]);
  mkdirSync(path.dirname(FAKE_CAMERA), { recursive: true });
  writeFileSync(FAKE_CAMERA, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
}

// The fake device reads the file each time a camera stream starts; it must exist when the browser launches.
mkdirSync(path.dirname(FAKE_CAMERA), { recursive: true });
writeFileSync(FAKE_CAMERA, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), Buffer.from("FRAME\n"), Buffer.alloc(W * H * 1.5, 128)]));
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${FAKE_CAMERA}`] },
  permissions: ["camera"],
});

const loginId = (who: string) => ({ operator: "MF0001-OP", qc: "MF0001-QC", ss1: "SS0001", ss2: "SS0002", vw: "VW0001" })[who]!;

async function api(baseURL: string, who: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const r = await ctx.post("/api/auth/login", { data: { loginId: loginId(who), password: PASSWORD } });
  expect(r.status(), `sign in ${who}`).toBe(200);
  return ctx;
}
async function signInPage(page: Page, who: string, path: string) {
  const r = await page.request.post("/api/auth/login", { data: { loginId: loginId(who), password: PASSWORD } });
  expect(r.status()).toBe(200);
  await page.goto(path);
}
const packsOf = (lot: string) => [1, 2, 3, 4].map((s) => `${lot}6${s}`);
const row = (page: Page, code: string) => page.locator(`[data-testid="checklist-row"][data-code="${code}"]`);
const count = (page: Page, name: string) => page.locator(`[data-count="${name}"]`);

/** A fresh printed case (and, with `pass`, QC-verified → PACKED) made through the API. */
async function newCases(baseURL: string, n: number, pass = false) {
  const op = await api(baseURL, "operator");
  const today = new Date().toISOString().slice(0, 10);
  const r = await op.post("/api/print-orders", { data: { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "MN", mfgDate: today, expiryDate: `${+today.slice(0, 4) + 1}${today.slice(4)}`, cases: n, trays: 0 }] } });
  expect(r.status()).toBe(200);
  const order = (await r.json()).printOrder as { id: string; lotCodes: string[] };
  expect((await op.post(`/api/print-orders/${order.id}/printed`, { data: {} })).status()).toBe(200);
  if (pass) {
    const qc = await api(baseURL, "qc");
    for (const lot of order.lotCodes) {
      const packs = packsOf(lot);
      await qc.post("/api/verify", { data: { action: "scanLot", code: lot } });
      expect((await (await qc.post("/api/verify", { data: { action: "confirm", lotCode: lot, packCodes: packs } })).json()).ok).toBe(true);
    }
    await qc.dispose();
  }
  await op.dispose();
  return order.lotCodes;
}

/** Records every camera stream the page opens, to check that its tracks are released (test instrumentation only). */
async function watchStreams(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await orig(c);
      w.__streams.push(s);
      return s;
    };
  });
}
const liveTracks = (page: Page) => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);
const openedStreams = (page: Page) => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length);

test.describe.serial("Scanning: camera, scanner, checklists", () => {
  const errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => /Content Security Policy|Refused to (load|execute|connect)/.test(m.text()) && errors.push(m.text()));
  });
  test.afterEach(() => expect(errors, "uncaught errors in the page").toEqual([]));

  test("QC with the camera: one submission per sticker, Stop releases the camera, scanner keys, duplicates, 100% unlocks Confirm", async ({ page, baseURL }) => {
    const [lot] = await newCases(baseURL!, 1);
    const packs = packsOf(lot);
    await watchStreams(page);
    const verifyCalls: string[] = [];
    page.on("request", (r) => r.url().endsWith("/api/verify") && r.method() === "POST" && verifyCalls.push(r.postDataJSON().code ?? r.postDataJSON().action));
    await signInPage(page, "qc", "/qc/verify");

    // Lot by keyboard-wedge scanner: the checklist lists its 4 packs, all PENDING.
    await page.locator("#scan-input").fill(lot);
    await page.locator("#scan-input").press("Enter");
    await expect(page.locator('[data-testid="checklist-row"]')).toHaveCount(4);
    for (const p of packs) await expect(row(page, p)).toHaveAttribute("data-status", "PENDING");
    await expect(count(page, "scanned")).toHaveText("0");
    await expect(page.getByRole("button", { name: "Confirm → PACKED" })).toBeDisabled();

    // Pack 1 by camera. The fake camera repeats the frame many times a second: exactly one request reaches the server.
    await showOnCamera(packs[0]);
    await page.getByRole("button", { name: "Use camera" }).click();
    await expect(page.locator("[data-camera-panel]")).toHaveAttribute("data-camera-state", "running");
    await expect(row(page, packs[0])).toHaveAttribute("data-status", "SCANNED", { timeout: 15_000 });
    await page.waitForTimeout(3000);
    expect(verifyCalls.filter((c) => c === packs[0])).toHaveLength(1);
    await expect(count(page, "scanned")).toHaveText("1");
    await expect(page.getByTestId("checklist-percent")).toHaveText("25%");

    // Stop releases every camera track; Start again on the next sticker.
    await page.getByRole("button", { name: "Stop camera" }).click();
    expect(await liveTracks(page)).toBe(0);
    await showOnCamera(packs[1]);
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(row(page, packs[1])).toHaveAttribute("data-status", "SCANNED", { timeout: 15_000 });
    await page.getByRole("button", { name: "Close camera" }).click();
    expect(await liveTracks(page)).toBe(0);

    // Keyboard-wedge: two codes typed back to back faster than the server answers — both accepted, in order.
    const input = page.locator("#scan-input");
    await input.focus();
    await page.keyboard.type(packs[2]);
    await page.keyboard.press("Enter");
    await page.keyboard.type(packs[3]);
    await page.keyboard.press("Enter");
    await expect(row(page, packs[3])).toHaveAttribute("data-status", "SCANNED");
    await expect(row(page, packs[2])).toHaveAttribute("data-status", "SCANNED");
    expect(verifyCalls.slice(-2)).toEqual([packs[2], packs[3]]);

    // Partial input is never sent; a bad format is explained, not sent.
    const before = verifyCalls.length;
    await page.keyboard.type(lot.slice(0, 9));
    await page.waitForTimeout(500);
    expect(verifyCalls.length).toBe(before);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "is not a Velza code" })).toBeVisible();
    expect(verifyCalls.length).toBe(before);
    await input.fill("");

    // A repeat scan: the server answers DUPLICATE_SCAN, the row stays SCANNED, nothing is counted twice.
    await input.fill(packs[0]);
    await input.press("Enter");
    await expect(page.getByTestId("scan-log").locator("li").first()).toContainText("already scanned");
    await expect(row(page, packs[0])).toHaveAttribute("data-status", "SCANNED");
    await expect(count(page, "scanned")).toHaveText("4");

    // 100%: completion shown, Confirm enabled — but nothing is confirmed until the button is pressed.
    await expect(page.getByTestId("checklist-percent")).toHaveText("100%");
    await expect(page.getByTestId("checklist-complete")).toBeVisible();
    const lookupBefore = await (await api(baseURL!, "qc")).post("/api/verify", { data: { action: "scanLot", code: lot } });
    expect((await lookupBefore.json()).lot.status).toBe("PRINTED");
    await page.getByRole("button", { name: "Confirm → PACKED" }).click();
    await expect(page.getByText(`Lot ${lot} verified → PACKED`)).toBeVisible();
  });

  test("QC: a pack of another lot and a missing pack keep the lot incomplete; quarantine still works", async ({ page, baseURL }) => {
    const [a, b] = await newCases(baseURL!, 2);
    await signInPage(page, "qc", "/qc/verify");
    const input = page.locator("#scan-input");
    await input.fill(a);
    await input.press("Enter");
    await input.fill(packsOf(b)[0]);
    await input.press("Enter");
    await expect(page.getByTestId("checklist-strays")).toContainText(packsOf(b)[0]);
    await expect(count(page, "rejected")).toHaveText("1");
    await expect(count(page, "scanned")).toHaveText("0");
    for (const p of packsOf(a).slice(0, 3)) {
      await input.fill(p);
      await input.press("Enter");
      await expect(row(page, p)).toHaveAttribute("data-status", "SCANNED");
    }
    await expect(page.getByTestId("missing-packs")).toContainText("1 pack still missing");
    await expect(page.getByRole("button", { name: "Confirm → PACKED" })).toBeDisabled();
    await page.getByPlaceholder(/Pack sticker missing/).fill("Pack 4 sticker missing");
    await page.getByRole("button", { name: "Quarantine lot" }).click();
    await expect(page.getByText(`Lot ${a} quarantined: Pack 4 sticker missing`)).toBeVisible();
  });

  test("camera permission refused: clear message, nothing scanned (mocked refusal)", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("denied", "NotAllowedError");
      };
    });
    await signInPage(page, "qc", "/qc/verify");
    await page.getByRole("button", { name: "Use camera" }).click();
    await expect(page.getByTestId("camera-error")).toContainText("Camera permission was refused");
    await expect(page.getByRole("button", { name: "Start camera" })).toBeVisible();
  });

  test("leaving the page releases the camera", async ({ page }) => {
    await watchStreams(page);
    await showOnCamera("91ZZZZZZOR0000161");
    await signInPage(page, "qc", "/qc/verify");
    await page.getByRole("button", { name: "Use camera" }).click();
    await expect(page.locator("[data-camera-panel]")).toHaveAttribute("data-camera-state", "running");
    expect(await liveTracks(page)).toBeGreaterThan(0);
    await page.locator("nav a", { hasText: "My stock" }).click();
    await expect(page).toHaveURL(/\/stock$/);
    expect(await openedStreams(page)).toBeGreaterThan(0);
    expect(await liveTracks(page)).toBe(0);
  });

  test("phone width: scanner, camera controls and checklist fit, no sideways scrolling", async ({ page, baseURL }) => {
    const [lot] = await newCases(baseURL!, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await signInPage(page, "qc", "/qc/verify");
    await page.locator("#scan-input").fill(lot);
    await page.locator("#scan-input").press("Enter");
    await expect(page.locator('[data-testid="checklist-row"]')).toHaveCount(4);
    await showOnCamera(packsOf(lot)[0]);
    await page.getByRole("button", { name: "Use camera" }).click();
    await expect(row(page, packsOf(lot)[0])).toHaveAttribute("data-status", "SCANNED", { timeout: 15_000 });
    const stop = await page.getByRole("button", { name: "Stop camera" }).boundingBox();
    expect(stop!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Close camera" }).click();
  });

  test("dispatch and receive checklists: ticked only after the server accepts; duplicates and removal; invoice shown on arrival", async ({ page, baseURL }) => {
    const lots = await newCases(baseURL!, 2, true);
    await signInPage(page, "operator", "/dispatch");
    const sel = page.getByLabel("Destination");
    // The plant ships only to the Velza Warehouse.
    await sel.selectOption((await sel.locator("option", { hasText: "VW-1" }).getAttribute("value"))!);
    await page.getByLabel("Invoice").fill("INV-SCAN-E2E");
    for (const l of lots) await expect(row(page, l)).toHaveAttribute("data-status", "PENDING");
    const input = page.locator("#scan-input");
    await input.fill(lots[0]);
    await input.press("Enter");
    await expect(row(page, lots[0])).toHaveAttribute("data-status", "SCANNED");
    const scannedBefore = await count(page, "scanned").innerText();
    await input.fill(lots[0]);
    await input.press("Enter");
    await expect(page.getByTestId("scan-log").locator("li").first()).toContainText("DUPLICATE_SCAN");
    await expect(count(page, "scanned")).toHaveText(scannedBefore);
    await page.getByRole("button", { name: `Remove ${lots[0]} from the dispatch` }).click();
    await expect(row(page, lots[0])).toHaveAttribute("data-status", "PENDING");
    await expect(page.getByRole("button", { name: /Confirm dispatch of 0 items/ })).toBeDisabled();
    for (const l of lots) {
      await input.fill(l);
      await input.press("Enter");
      await expect(row(page, l)).toHaveAttribute("data-status", "SCANNED");
    }
    await page.getByRole("button", { name: /Confirm dispatch of 2 items/ }).click();
    await expect(page.getByText(/Dispatched 2 item\(s\) to .*VW-1.* on INV-SCAN-E2E/)).toBeVisible();
    for (const l of lots) await expect(row(page, l)).toHaveCount(0); // left the stock list

    // A Super Stockist cannot receive them; the warehouse sees them with the invoice and ticks them on receipt.
    const ss2 = await api(baseURL!, "ss2");
    expect((await (await ss2.post("/api/receive", { data: { code: lots[0] } })).json()).code).toBe("WRONG_RECEIVER");
    await signInPage(page, "vw", "/receive");
    for (const l of lots) {
      await expect(row(page, l)).toHaveAttribute("data-status", "PENDING");
      await expect(row(page, l)).toContainText("INV-SCAN-E2E");
    }
    await page.locator("#scan-input").fill(lots[0]);
    await page.locator("#scan-input").press("Enter");
    await expect(row(page, lots[0])).toHaveAttribute("data-status", "SCANNED");
    await page.locator("#scan-input").fill(lots[0]);
    await page.locator("#scan-input").press("Enter");
    await expect(page.getByTestId("scan-log").locator("li").first()).toContainText("DUPLICATE_RECEIPT");
    await expect(row(page, lots[0])).toHaveAttribute("data-status", "SCANNED");
    await expect(row(page, lots[1])).toHaveAttribute("data-status", "PENDING");
  });
});
