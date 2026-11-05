// Admin guards that keep the chain readable and stock reachable: no deactivating a partner with stock on the way
// to it, no deactivating a country that printed codes use, no newly assigning to an inactive parent, a safe QR base
// URL, and a refill level within the issue size. Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStore } from "@/lib/store";
import { createEntity, registerPartner, updateEntity, updateSettings } from "@/lib/services/admin";
import { dispatch, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const store = () => getStore();
const ADMIN = "AD0001";
const OP = "MF0001-OP";
const QC = "MF0001-QC";

async function qcPassedLot(): Promise<string> {
  const r = await createPrintOrder(OP, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 1, trays: 0 }] });
  if (r.preview) throw new Error("expected an order");
  await markPrinted(OP, r.printOrder.id);
  const lotCode = r.printOrder.lotCodes[0];
  const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
  await verify(QC, { action: "scanLot", code: lotCode });
  for (const [i, code] of packs.entries()) await verify(QC, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
  await verify(QC, { action: "confirm", lotCode, packCodes: packs });
  return lotCode;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-admin-validation-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
}, 60_000);
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("deactivating a partner (REF-9)", () => {
  it("is refused while a consignment is on the way to it, and allowed once it is received", async () => {
    const lot = await qcPassedLot();
    await dispatch(OP, { action: "confirm", toPartnerId: "SS0002", invoice: "INV-ADM-1", codes: [lot] });
    await expect(updateEntity(ADMIN, "partners", "SS0002", { active: false })).rejects.toMatchObject({
      status: 400,
      code: "IN_TRANSIT",
      message: expect.stringMatching(/SS-2 .*\(SS0002\) has 1 lot\(s\) on the way to it/),
    });
    expect((await store().partners.get("SS0002"))!.active).toBe(true);
    // Other edits of the same partner are not blocked.
    await expect(updateEntity(ADMIN, "partners", "SS0002", { place: "Koramangala 5th Block" })).resolves.toMatchObject({ place: "Koramangala 5th Block" });
    expect(await receive("SS0002", { code: lot })).toMatchObject({ ok: true });
    await expect(updateEntity(ADMIN, "partners", "SS0002", { active: false })).resolves.toMatchObject({ active: false });
  });
});

describe("assigning to an inactive parent", () => {
  it("is refused on registration and on reassignment; older rows under it can still be edited", async () => {
    // SS0002 was deactivated above; DB0002 is assigned to it.
    const form = {
      type: "DB", name: "Indiranagar Distributors", place: "Indiranagar", address: "12 CMH Road", city: "Bengaluru", state: "Karnataka",
      contactPerson: "Ravi", phone: "+91 90000 77701", parentId: "SS0002", password: "First2026pass",
    };
    await expect(registerPartner(ADMIN, form)).rejects.toMatchObject({ code: "BAD_PARENT", message: expect.stringMatching(/\(SS0002\) is inactive/) });
    await expect(updateEntity(ADMIN, "partners", "DB0001", { parentId: "SS0002" })).rejects.toMatchObject({ code: "BAD_PARENT" });
    expect((await store().partners.get("DB0001"))!.parentId).toBe("SS0001");
    await expect(updateEntity(ADMIN, "partners", "DB0002", { phone: "+91 90000 77702" })).resolves.toMatchObject({ phone: "+91 90000 77702", parentId: "SS0002" });
    // Moving it to an active parent works.
    await expect(updateEntity(ADMIN, "partners", "DB0002", { parentId: "SS0001" })).resolves.toMatchObject({ parentId: "SS0001" });
  });
});

describe("deactivating a country (REF-10)", () => {
  it("refuses the default country and a country batches use; an unused country can be deactivated", async () => {
    const india = (await store().countries.findOne({ code: "91" }))!;
    await expect(updateEntity(ADMIN, "countries", india.id, { active: false })).rejects.toMatchObject({
      code: "IN_USE",
      message: expect.stringMatching(/the default country setting/),
    });
    const spare = await createEntity(ADMIN, "countries", { code: "92", name: "Test land" });
    await expect(updateEntity(ADMIN, "countries", spare.id, { active: false })).resolves.toMatchObject({ active: false });
    await expect(updateEntity(ADMIN, "countries", spare.id, { active: true })).resolves.toMatchObject({ active: true });
    // A country with batches but not the default: still refused.
    await updateSettings(ADMIN, { defaultCountry: "92" });
    await expect(updateEntity(ADMIN, "countries", india.id, { active: false })).rejects.toMatchObject({ code: "IN_USE", message: expect.stringMatching(/batch\(es\)/) });
    await updateSettings(ADMIN, { defaultCountry: "91" });
    expect((await store().countries.findOne({ code: "91" }))!.active).toBe(true);
  });
});

describe("settings", () => {
  it("the public QR base URL must be https (http only for localhost / LAN), with no credentials, query or fragment", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://a.example", "http://evil.com", "https://u:p@x.com", "https://x.com/?a=1", "https://x.com/#f", "not a url"]) {
      await expect(updateSettings(ADMIN, { publicBaseUrl: bad }), bad).rejects.toThrow();
    }
    for (const good of ["https://trace.velza.in", "http://localhost:3000", "http://192.168.1.20:3000", "https://trace.velza.in/app"]) {
      await expect(updateSettings(ADMIN, { publicBaseUrl: good })).resolves.toMatchObject({ publicBaseUrl: good });
    }
    await expect(updateSettings(ADMIN, { publicBaseUrl: "  https://trace.velza.in  " })).resolves.toMatchObject({ publicBaseUrl: "https://trace.velza.in" });
  });

  it("the provisional suspect-clone limits can be set by the Admin, within range", async () => {
    await expect(updateSettings(ADMIN, { publicCloneScanThreshold: 8, publicCloneWindowHours: 12 })).resolves.toMatchObject({ publicCloneScanThreshold: 8, publicCloneWindowHours: 12 });
    for (const bad of [{ publicCloneScanThreshold: 1 }, { publicCloneScanThreshold: 2.5 }, { publicCloneWindowHours: 0 }, { publicCloneWindowHours: 721 }]) {
      await expect(updateSettings(ADMIN, bad), JSON.stringify(bad)).rejects.toThrow();
    }
    await updateSettings(ADMIN, { publicCloneScanThreshold: 5, publicCloneWindowHours: 24 });
  });

  it("refill level must not be above the issue size, whichever of the two is changed", async () => {
    await expect(updateSettings(ADMIN, { poolIssueSize: 10, poolRefillBelow: 20 })).rejects.toMatchObject({ code: "BAD_POOL" });
    await expect(updateSettings(ADMIN, { poolIssueSize: 10, poolRefillBelow: 10 })).resolves.toMatchObject({ poolIssueSize: 10, poolRefillBelow: 10 });
    await expect(updateSettings(ADMIN, { poolRefillBelow: 11 })).rejects.toMatchObject({ code: "BAD_POOL" });
    await expect(updateSettings(ADMIN, { poolIssueSize: 5 })).rejects.toMatchObject({ code: "BAD_POOL" });
    await expect(updateSettings(ADMIN, { poolIssueSize: 10, poolRefillBelow: 5 })).resolves.toMatchObject({ poolIssueSize: 10, poolRefillBelow: 5 });
  });
});
