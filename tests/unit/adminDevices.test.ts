// Admin → Devices: names unique per plant (trimmed, spaces collapsed, any case), deleting a device returns
// its unused pool codes in the same transaction, and "not found" messages name things the way people do.
// Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStore } from "@/lib/store";
import { createEntity, deleteEntity, registerPartner, updateEntity } from "@/lib/services/admin";
import { createPrintOrder } from "@/lib/services/printOrders";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const store = () => getStore();
const ADMIN = "AD0001";
const MF1 = "MF0001";
let MF2 = "";

const addDevice = (manufacturerId: string, name: string) => createEntity(ADMIN, "devices", { manufacturerId, name });
const poolOf = async (deviceId: string) => (await store().batchCodePool.list({ deviceId })).map((p) => p.status).sort();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-devices-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  const r = await registerPartner(ADMIN, {
    type: "MANUFACTURER", name: "Second Plant", place: "Zone 2", address: "Plot 2", city: "Nashik", contactPerson: "Plant Two",
    phone: "+91 90000 55501", password: "Second2026pass", qcPassword: "Second2026pass",
  });
  MF2 = r.partner.id;
}, 60_000);
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("device names", () => {
  it("must be unique within a plant: same name, other case, extra spaces are all refused", async () => {
    await addDevice(MF1, "Line-7 PC");
    for (const name of ["Line-7 PC", "line-7 pc", "  LINE-7   PC  "]) {
      await expect(addDevice(MF1, name)).rejects.toMatchObject({ status: 400, code: "DUPLICATE", message: expect.stringContaining('already has a device named "Line-7 PC"') });
    }
    expect((await store().devices.list({ manufacturerId: MF1 })).filter((d) => d.name.toLowerCase().includes("line-7"))).toHaveLength(1);
  });

  it("the same name is fine at another plant", async () => {
    await expect(addDevice(MF2, "Line-7 PC")).resolves.toMatchObject({ manufacturerId: MF2, name: "Line-7 PC" });
  });

  it("two submissions of the same name at once create one device", async () => {
    const results = await Promise.allSettled([addDevice(MF1, "Packing PC"), addDevice(MF1, "Packing PC"), addDevice(MF1, "packing pc")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "DUPLICATE" });
    expect((await store().devices.list({ manufacturerId: MF1 })).filter((d) => d.name.toLowerCase() === "packing pc")).toHaveLength(1);
  });

  it("renaming onto another device's name is refused; other edits of a device are not blocked", async () => {
    const d = await addDevice(MF1, "Rename Me");
    await expect(updateEntity(ADMIN, "devices", d.id, { name: "line-7 pc" })).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(updateEntity(ADMIN, "devices", d.id, { name: "Renamed PC" })).resolves.toMatchObject({ name: "Renamed PC" });
    await expect(updateEntity(ADMIN, "devices", d.id, { offline: true })).resolves.toMatchObject({ offline: true });
  });

  it("an older look-alike pair (from before this rule) can still be edited without renaming", async () => {
    // Written straight to the store, as data from before the rule would be.
    const id = crypto.randomUUID();
    await store().devices.create({ id, manufacturerId: MF1, name: "LINE-7 PC", offline: false, lastSyncAt: null });
    await expect(updateEntity(ADMIN, "devices", id, { offline: true })).resolves.toMatchObject({ offline: true });
  });
});

describe("deleting a device", () => {
  it("returns its unused (RESERVED) pool codes; nothing is orphaned or reassigned", async () => {
    const d = await addDevice(MF2, "Spare PC");
    expect(await poolOf(d.id)).toEqual(Array(10).fill("RESERVED"));
    const otherDevices = await store().devices.list({ manufacturerId: MF2 });
    const otherBefore = await Promise.all(otherDevices.filter((x) => x.id !== d.id).map((x) => poolOf(x.id)));
    expect(await deleteEntity(ADMIN, "devices", d.id)).toMatchObject({ ok: true, message: "Deleted Spare PC" });
    expect(await store().devices.get(d.id)).toBeNull();
    expect(await poolOf(d.id)).toEqual(Array(10).fill("RETURNED"));
    const otherAfter = await Promise.all(otherDevices.filter((x) => x.id !== d.id).map((x) => poolOf(x.id)));
    expect(otherAfter).toEqual(otherBefore);
  });

  it("a device with batches cannot be deleted, and its pool is left exactly as it was (all-or-nothing)", async () => {
    const plantPc = (await store().devices.list({ manufacturerId: MF1 }))[0];
    const operator = (await store().users.list({ role: "OPERATOR", partnerId: MF1 }))[0].id;
    await createPrintOrder(operator, { deviceId: plantPc.id, batches: [{ flavour: "OR", mfgDate: "2026-10-01", expiryDate: "2027-10-01", cases: 1, trays: 0 }] });
    const before = (await store().batchCodePool.list({ deviceId: plantPc.id })).map((p) => `${p.code}:${p.status}`).sort();
    expect(before.some((x) => x.endsWith(":USED"))).toBe(true);
    await expect(deleteEntity(ADMIN, "devices", plantPc.id)).rejects.toMatchObject({ code: "IN_USE" });
    expect(await store().devices.get(plantPc.id)).not.toBeNull();
    expect((await store().batchCodePool.list({ deviceId: plantPc.id })).map((p) => `${p.code}:${p.status}`).sort()).toEqual(before);
  });
});

describe("not-found messages", () => {
  it("name the thing, not the internal table", async () => {
    await expect(deleteEntity(ADMIN, "partners", "RT9999")).rejects.toMatchObject({ status: 404, message: "Partner RT9999 not found" });
    await expect(updateEntity(ADMIN, "devices", "nope", { offline: true })).rejects.toMatchObject({ status: 404, message: "Device nope not found" });
  });
});
