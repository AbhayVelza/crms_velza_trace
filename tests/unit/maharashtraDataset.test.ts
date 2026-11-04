// The 18-partner Maharashtra QA network (tests/qa/maharashtraDataset.ts), registered through the real
// registration service on a fresh store: counts, assignments, the one-Super-Stockist-per-state rule, locked
// fields, and each partner seeing and supplying only its own part of the chain.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStore } from "@/lib/store";
import { buildBaseSeed } from "@/lib/store/seedData";
import { createEntity, listEntity, updateEntity } from "@/lib/services/admin";
import { destinations, myPartners } from "@/lib/services/movement";
import type { Partner } from "@/lib/core/types";
import { EXPECTED_COUNTS, MAHARASHTRA_PARTNERS, matchQaPartner, QA_PREFIX } from "../qa/maharashtraDataset";

const PASSWORD = "Qa2026maharashtra";
let dir: string;
/** QA code → partner ID issued by the app. */
const ids = new Map<string, string>();
const idOf = (code: string) => ids.get(code)!;

async function partners(): Promise<Partner[]> {
  return (await listEntity("AD0001", "partners")) as Partner[];
}

// Setup registers 18 partners (scrypt-hashed passwords); allow more than the default 10 s hook time.
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-qa-mh-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await getStore().reset(buildBaseSeed({ admin: "Admin2026pass", hq: "Hq2026pass" }));
  for (const qp of MAHARASHTRA_PARTNERS) {
    const { code, parent, ...fields } = qp;
    const r = (await createEntity("AD0001", "partners", { ...fields, parentId: parent ? idOf(parent) : null, password: PASSWORD, qcPassword: PASSWORD })) as {
      partner: Partner;
    };
    ids.set(code, r.partner.id);
  }
}, 60_000);
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Maharashtra QA network (18 partners)", () => {
  it("has exactly 1 manufacturer, 2 super stockists, 5 distributors and 10 retailers, with IDs in sequence", async () => {
    const qa = (await partners()).filter((p) => p.name.startsWith(QA_PREFIX));
    expect(qa).toHaveLength(18);
    for (const [type, n] of Object.entries(EXPECTED_COUNTS)) expect(qa.filter((p) => p.type === type)).toHaveLength(n);
    expect(qa.map((p) => p.id).sort()).toEqual(
      ["MF0001", "SS0001", "SS0002", ...[1, 2, 3, 4, 5].map((n) => `DB000${n}`), ...Array.from({ length: 10 }, (_, i) => `RT${String(i + 1).padStart(4, "0")}`)].sort(),
    );
    expect(new Set(qa.map((p) => p.id)).size).toBe(18);
  });

  it("every child is assigned to the parent named in the dataset, and every record is findable by its QA code", async () => {
    const all = await partners();
    for (const qp of MAHARASHTRA_PARTNERS) {
      const found = matchQaPartner(all, qp.code);
      expect(found, qp.code).toHaveLength(1);
      expect(found[0]).toMatchObject({ type: qp.type, parentId: qp.parent ? idOf(qp.parent) : null, state: qp.state, city: qp.city, pincode: qp.pincode, active: true });
    }
  });

  it("is in Maharashtra except SS-002, which the one-SS-per-state rule puts in Goa", async () => {
    const qa = (await partners()).filter((p) => p.name.startsWith(QA_PREFIX));
    expect(qa.filter((p) => p.state !== "Maharashtra").map((p) => p.name)).toEqual([`${QA_PREFIX}-SS-002 Konkan Coast Super Stockist`]);
  });

  it("refuses a second Super Stockist in Maharashtra", async () => {
    await expect(
      createEntity("AD0001", "partners", { ...MAHARASHTRA_PARTNERS[1], name: `${QA_PREFIX}-NEG second MH SS`, phone: "+91 00000 202699", email: "neg@example.com", parentId: null, password: PASSWORD }),
    ).rejects.toMatchObject({ code: "STATE_TAKEN" });
    expect((await partners()).filter((p) => p.type === "SS" && p.state === "Maharashtra")).toHaveLength(1);
  });

  it("refuses a duplicate phone or email, and assignments to the wrong tier", async () => {
    const dst1 = MAHARASHTRA_PARTNERS.find((p) => p.code.endsWith("DST-001"))!;
    const base = { ...dst1, name: `${QA_PREFIX}-NEG`, phone: "+91 00000 202698", email: "neg2@example.com", parentId: idOf(dst1.parent!), password: PASSWORD };
    await expect(createEntity("AD0001", "partners", { ...base, phone: dst1.phone })).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(createEntity("AD0001", "partners", { ...base, email: dst1.email.toUpperCase() })).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(createEntity("AD0001", "partners", { ...base, parentId: idOf(`${QA_PREFIX}-RTL-001`) })).rejects.toMatchObject({ code: "BAD_PARENT" });
    await expect(createEntity("AD0001", "partners", { ...base, parentId: idOf(`${QA_PREFIX}-MFG-001`) })).rejects.toMatchObject({ code: "BAD_PARENT" });
    await expect(createEntity("AD0001", "partners", { ...base, type: "SS", state: "Kerala", parentId: idOf(`${QA_PREFIX}-SS-001`) })).rejects.toMatchObject({ code: "BAD_PARENT" });
    await expect(createEntity("AD0001", "partners", { ...base, parentId: "DB9999" })).rejects.toMatchObject({ code: "BAD_PARENT" });
    expect((await partners()).filter((p) => p.name.startsWith(`${QA_PREFIX}-NEG`))).toHaveLength(0);
  });

  it("locks the tier and keeps assignments valid on edit", async () => {
    const dst1 = idOf(`${QA_PREFIX}-DST-001`);
    await expect(updateEntity("AD0001", "partners", dst1, { type: "RETAILER" })).rejects.toMatchObject({ code: "TYPE_LOCKED" });
    await expect(updateEntity("AD0001", "partners", dst1, { parentId: idOf(`${QA_PREFIX}-RTL-002`) })).rejects.toMatchObject({ code: "BAD_PARENT" });
    await expect(updateEntity("AD0001", "partners", idOf(`${QA_PREFIX}-SS-002`), { state: "Maharashtra" })).rejects.toMatchObject({ code: "STATE_TAKEN" });
    expect((await partners()).find((p) => p.id === dst1)).toMatchObject({ type: "DB", parentId: idOf(`${QA_PREFIX}-SS-001`) });
  });

  it("only Velza Admin can register or edit partners", async () => {
    for (const who of ["HQ0001", idOf(`${QA_PREFIX}-SS-001`), idOf(`${QA_PREFIX}-DST-001`), idOf(`${QA_PREFIX}-RTL-001`)]) {
      await expect(listEntity(who, "partners")).rejects.toMatchObject({ status: 403 });
      await expect(updateEntity(who, "partners", idOf(`${QA_PREFIX}-RTL-001`), { name: "hijacked" })).rejects.toMatchObject({ status: 403 });
    }
    expect((await partners()).find((p) => p.id === idOf(`${QA_PREFIX}-RTL-001`))!.name).toMatch(/^QA-MH-2026-RTL-001 /);
  });

  it("each Super Stockist and Distributor sees and supplies only its own partners", async () => {
    const ss1 = await myPartners(idOf(`${QA_PREFIX}-SS-001`));
    expect(ss1.partners.map((p) => p.id).sort()).toEqual([1, 2, 3].map((n) => idOf(`${QA_PREFIX}-DST-00${n}`)).sort());
    const ss2 = await myPartners(idOf(`${QA_PREFIX}-SS-002`));
    expect(ss2.partners.map((p) => p.id).sort()).toEqual([4, 5].map((n) => idOf(`${QA_PREFIX}-DST-00${n}`)).sort());
    for (let d = 1; d <= 5; d++) {
      const mine = await myPartners(idOf(`${QA_PREFIX}-DST-00${d}`));
      expect(mine.partners.map((p) => p.id).sort(), `DST-00${d}`).toEqual([2 * d - 1, 2 * d].map((n) => idOf(`${QA_PREFIX}-RTL-${String(n).padStart(3, "0")}`)).sort());
      const dest = await destinations(idOf(`${QA_PREFIX}-DST-00${d}`));
      expect(dest.destinations.map((p) => p.id).sort()).toEqual(mine.partners.map((p) => p.id).sort());
    }
    await expect(myPartners(idOf(`${QA_PREFIX}-RTL-001`))).rejects.toMatchObject({ status: 403 });
    // The plant supplies any Super Stockist (there is no plant → SS assignment).
    expect((await destinations(`${idOf(`${QA_PREFIX}-MFG-001`)}-OP`)).destinations.map((p) => p.id).sort()).toEqual([idOf(`${QA_PREFIX}-SS-001`), idOf(`${QA_PREFIX}-SS-002`)].sort());
  });
});
