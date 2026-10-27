// One portal per role, territories (an SS with 50 distributors, a DB with 50 retailers, retailers assigned
// to an SS directly), admin deletes, clean seed.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { buildBaseSeed } from "@/lib/store/seedData";
import { createEntity, deleteEntity, listEntity, updateEntity } from "@/lib/services/admin";
import { buildSampleSeed } from "../fixtures/sampleNetwork";
import { destinations, dispatch, myPartners } from "@/lib/services/movement";
import { dashboard, lookup } from "@/lib/services/trace";

let dir: string;
const store = () => getStore();
const ids: Record<string, string> = {};

async function userId(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
const partnerId = async (prefix: string) => (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-access-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  ids.admin = await userId("ADMIN");
  ids.hq = await userId("TRACE_OWNER");
  ids.ss1 = await userId("SS", "SS-1");
  ids.ss2 = await userId("SS", "SS-2");
  ids.operator = await userId("OPERATOR");
  ids.SS1 = await partnerId("SS-1");
  ids.SS2 = await partnerId("SS-2");
  ids.DB1 = await partnerId("DB-1");
  ids.DB2 = await partnerId("DB-2");
  ids.db1 = await userId("DB", "DB-1");
  ids.db2 = await userId("DB", "DB-2");
  ids.rt1 = await userId("RETAILER", "Retailer-1");
  ids.MF = await partnerId("Demo Manufacturer");
  ids.RT1 = await partnerId("Retailer-1"); // DB-1's
  ids.RT2 = await partnerId("Retailer-2"); // DB-1's
  ids.RT3 = await partnerId("Retailer-3"); // DB-2's
  ids.RT4 = await partnerId("Retailer-4"); // SS-1's directly
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("one portal per role", () => {
  it("HQ dashboard and search are for Velza HQ only", async () => {
    await expect(dashboard(ids.hq)).resolves.toBeTruthy();
    for (const who of [ids.admin, ids.ss1, ids.operator]) {
      await expect(dashboard(who)).rejects.toMatchObject({ status: 403 });
      await expect(lookup(who, "91ZZZZZZOR00001")).rejects.toMatchObject({ status: 403 });
    }
  });

  it("admin screens are for Velza Admin only", async () => {
    for (const who of [ids.hq, ids.ss1, ids.operator]) await expect(listEntity(who, "users")).rejects.toMatchObject({ status: 403 });
  });

  it("not signed in → 401", async () => {
    await expect(dashboard(null)).rejects.toMatchObject({ status: 401 });
  });
});

describe("assignment chain: SS → DB → Retailer, and SS → Retailer for a few retailers", () => {
  const sorted = (ps: { id: string }[]) => ps.map((p) => p.id).sort();

  it("each SS sees and dispatches only to its distributors and the retailers assigned to it directly", async () => {
    const dest = await destinations(ids.ss1);
    expect(dest.destinationTypes).toEqual(["DB", "RETAILER"]);
    expect(sorted(dest.destinations)).toEqual([ids.DB1, ids.RT4].sort());
    expect(sorted((await destinations(ids.ss2)).destinations)).toEqual([ids.DB2]);
    // Distributors first, then retailers; not the retailers of its distributors.
    const mine = await myPartners(ids.ss1);
    expect(mine.childTypes).toEqual(["DB", "RETAILER"]);
    expect(mine.partners.map((p) => [p.id, p.type])).toEqual([
      [ids.DB1, "DB"],
      [ids.RT4, "RETAILER"],
    ]);
    expect(mine.partners.map((p) => p.id)).not.toContain(ids.RT1);
    await expect(myPartners(ids.operator)).rejects.toMatchObject({ status: 403 });
    await expect(myPartners(ids.rt1)).rejects.toMatchObject({ status: 403 });
    await expect(destinations(ids.rt1)).rejects.toMatchObject({ status: 403 });
    const r = await dispatch(ids.ss2, { action: "check", toPartnerId: ids.DB1, invoice: "INV-1", code: "91ZZZZZZOR00001" });
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_CODE" }); // unknown code checked first…
    await expect(dispatch(ids.ss2, { action: "confirm", toPartnerId: ids.DB1, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/not one of .*assigned distributors/);
    await expect(dispatch(ids.ss2, { action: "confirm", toPartnerId: ids.RT4, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/not one of .*assigned retailers/);
    // An SS does not skip its own distributors: their retailers are theirs.
    await expect(dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.RT1, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/not one of .*assigned retailers/);
  });

  it("a Distributor sees and dispatches only to its own retailers", async () => {
    const dest = await destinations(ids.db1);
    expect(dest.destinationTypes).toEqual(["RETAILER"]);
    expect(sorted(dest.destinations)).toEqual([ids.RT1, ids.RT2].sort());
    const mine = await myPartners(ids.db1);
    expect(mine.childTypes).toEqual(["RETAILER"]);
    expect(mine.partners.map((p) => p.id)).toEqual([ids.RT1, ids.RT2]);
    expect(sorted((await myPartners(ids.db2)).partners)).toEqual([ids.RT3]);
    // Not another Distributor's retailer, not a retailer its SS supplies directly, not another tier.
    await expect(dispatch(ids.db1, { action: "confirm", toPartnerId: ids.RT3, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/assigned retailers/);
    await expect(dispatch(ids.db1, { action: "confirm", toPartnerId: ids.RT4, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/assigned retailers/);
    await expect(dispatch(ids.db1, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/can only dispatch to RETAILER/);
    await expect(dispatch(ids.db1, { action: "confirm", toPartnerId: ids.DB2, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/can only dispatch to RETAILER/);
    await expect(dispatch(ids.ss1, { action: "confirm", toPartnerId: ids.MF, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/can only dispatch to DB or RETAILER/);
  });

  it("Admin reassigns partners: a DB to an SS, a Retailer to a DB or an SS", async () => {
    await updateEntity(ids.admin, "partners", ids.DB1, { parentId: ids.SS2 });
    expect(sorted((await destinations(ids.ss2)).destinations)).toEqual([ids.DB1, ids.DB2].sort());
    expect(sorted((await destinations(ids.ss1)).destinations)).toEqual([ids.RT4]);
    await expect(updateEntity(ids.admin, "partners", ids.DB1, { parentId: ids.DB2 })).rejects.toThrow(/Super Stockist/);
    await expect(updateEntity(ids.admin, "partners", ids.DB1, { parentId: ids.RT1 })).rejects.toThrow(/Super Stockist/);
    await expect(updateEntity(ids.admin, "partners", ids.SS1, { parentId: ids.SS2 })).rejects.toThrow(/is not assigned to anyone/);
    await expect(updateEntity(ids.admin, "partners", ids.RT1, { parentId: ids.MF })).rejects.toThrow(/must be assigned to a Distributor or Super Stockist/);
    await expect(updateEntity(ids.admin, "partners", ids.RT1, { parentId: ids.RT2 })).rejects.toThrow(/must be assigned to a Distributor or Super Stockist/);
    await updateEntity(ids.admin, "partners", ids.DB1, { parentId: ids.SS1 });

    // DB-2's retailer moves to DB-1, then to SS-2 directly, then back.
    await updateEntity(ids.admin, "partners", ids.RT3, { parentId: ids.DB1 });
    expect((await destinations(ids.db1)).destinations).toHaveLength(3);
    expect((await destinations(ids.db2)).destinations).toEqual([]);
    await updateEntity(ids.admin, "partners", ids.RT3, { parentId: ids.SS2 });
    expect(sorted((await destinations(ids.ss2)).destinations)).toEqual([ids.DB2, ids.RT3].sort());
    expect(sorted((await myPartners(ids.ss2)).partners)).toEqual([ids.DB2, ids.RT3].sort());
    expect((await destinations(ids.db1)).destinations).toHaveLength(2);
    await updateEntity(ids.admin, "partners", ids.RT3, { parentId: ids.DB2 });
    expect(sorted((await destinations(ids.ss2)).destinations)).toEqual([ids.DB2]);
  });
});

describe("Super Stockist with 50 distributors, Distributor with 50 retailers", () => {
  let phone = 9100000000;
  const register = async (type: string, name: string, state: string, parentId: string | null = null) =>
    (
      (await createEntity(ids.admin, "partners", {
        type,
        name,
        place: "Main Road",
        address: "1 Main Road",
        city: "City",
        state,
        contactPerson: "Person",
        phone: String(phone++),
        password: "First2026pass",
        parentId,
      })) as { partner: { id: string } }
    ).partner;
  const make = (n: number, type: string, parentId: string | null, prefix: string) =>
    Promise.all(Array.from({ length: n }, (_, i) => register(type, `${prefix} ${type} ${i + 1}`, "Gujarat", parentId)));
  const sorted = (ps: { id: string }[]) => ps.map((p) => p.id).sort();
  let gujarat: { id: string };
  let gujaratDbs: { id: string }[];

  it("an SS sees exactly its 50 distributors — not the other Super Stockist's, not unassigned ones", async () => {
    gujarat = await register("SS", "Gujarat SS", "Gujarat");
    const goa = await register("SS", "Goa SS", "Goa");
    gujaratDbs = await make(50, "DB", gujarat.id, "Gujarat");
    await make(30, "DB", goa.id, "Goa");
    await make(5, "DB", null, "Unassigned");

    // The registration form made the SS's sign-in: its own partner ID.
    expect(sorted((await destinations(gujarat.id)).destinations)).toEqual(sorted(gujaratDbs));
    expect((await myPartners(gujarat.id)).partners).toHaveLength(50);

    // Deactivated distributors drop out of the dispatch list
    await updateEntity(ids.admin, "partners", gujaratDbs[0].id, { active: false });
    expect((await destinations(gujarat.id)).destinations).toHaveLength(49);
  });

  it("a DB sees exactly its 50 retailers — not another DB's, not the ones its SS supplies directly", async () => {
    const [db, otherDb] = [gujaratDbs[1], gujaratDbs[2]];
    const mine = await make(50, "RETAILER", db.id, "Mine");
    const theirs = await make(10, "RETAILER", otherDb.id, "Theirs");
    const direct = await make(5, "RETAILER", gujarat.id, "Direct");
    await make(3, "RETAILER", null, "Unassigned");

    // Its sign-in is its partner ID.
    const dest = await destinations(db.id);
    expect(sorted(dest.destinations)).toEqual(sorted(mine));
    const partners = (await myPartners(db.id)).partners;
    expect(sorted(partners)).toEqual(sorted(mine));
    expect(partners.every((p) => p.type === "RETAILER")).toBe(true);
    expect(sorted((await destinations(otherDb.id)).destinations)).toEqual(sorted(theirs));

    // The SS: its 50 distributors (one inactive, so 49 to dispatch to) and its 5 direct retailers, nobody's retailers.
    const ss = await myPartners(gujarat.id);
    expect(ss.partners).toHaveLength(55);
    expect(ss.partners.slice(0, 50).every((p) => p.type === "DB")).toBe(true);
    expect(sorted(ss.partners.slice(50))).toEqual(sorted(direct));
    expect(sorted((await destinations(gujarat.id)).destinations)).toEqual([...sorted(gujaratDbs.slice(1)), ...sorted(direct)].sort());

    // Deactivated retailers drop out of the dispatch list
    await updateEntity(ids.admin, "partners", mine[0].id, { active: false });
    expect((await destinations(db.id)).destinations).toHaveLength(49);
  });
});

describe("clean base seed", () => {
  it("has no made-up partners, people or devices", () => {
    const seed = buildBaseSeed();
    expect(seed.partners).toEqual([]);
    expect(seed.devices).toEqual([]);
    expect(seed.batchCodePool).toEqual([]);
    expect(seed.users.map((u) => [u.id, u.name])).toEqual([
      ["AD0001", "Velza Admin"],
      ["HQ0001", "Velza HQ"],
    ]);
    expect(seed.users.every((u) => u.passwordHash?.startsWith("scrypt$"))).toBe(true);
  });
});

describe("admin deletes", () => {
  it("deletes unused rows, refuses rows that are in use", async () => {
    const { partner: p } = (await createEntity(ids.admin, "partners", {
      type: "RETAILER",
      name: "Retailer-9 Test",
      place: "Camp",
      address: "9 MG Road",
      city: "Pune",
      state: "Maharashtra",
      contactPerson: "Test",
      phone: "+91 90000 99999",
      password: "First2026pass",
    })) as { partner: { id: string } };
    // The partner goes, and its sign-in (no history yet) with it.
    expect(await deleteEntity(ids.admin, "partners", p.id)).toMatchObject({ ok: true, message: expect.stringMatching(/and sign-in RT/) });
    expect(await store().users.get(p.id)).toBeNull();
    await expect(deleteEntity(ids.admin, "partners", ids.SS1)).rejects.toThrow(/assigned partner/);
    const f = (await createEntity(ids.admin, "flavours", { code: "ZZ", name: "Test" })) as { id: string };
    expect(await deleteEntity(ids.admin, "flavours", f.id)).toMatchObject({ ok: true });
    const country = (await store().countries.list())[0];
    await expect(deleteEntity(ids.admin, "countries", country.id)).rejects.toThrow(/default country/);
    await expect(deleteEntity(ids.ss1, "flavours", f.id)).rejects.toMatchObject({ status: 403 });
  });
});
