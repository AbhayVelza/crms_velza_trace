// Self sign-up (design: docs/superpowers/specs/2026-11-14-self-signup-design.md): SS, DB and Retailer shops create
// their own accounts. A Retailer works at once; an SS or DB waits for Velza Admin to approve or reject it.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStore } from "@/lib/store";
import { decideApproval, updateEntity } from "@/lib/services/admin";
import { login } from "@/lib/services/auth";
import { signup, signupOptions } from "@/lib/services/signup";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const store = () => getStore();
let phone = 9400000000;
const PASSWORD = "Shop2026pass";

const form = (over: Record<string, unknown> = {}) => ({
  type: "RETAILER",
  name: "Kothrud Kirana",
  place: "Kothrud",
  address: "Shop 4, Paud Road",
  city: "Pune",
  state: "Maharashtra",
  pincode: "411038",
  contactPerson: "Ravi Joshi",
  phone: `+91 ${phone++}`,
  email: "",
  parentId: "DB0001",
  password: PASSWORD,
  ...over,
});
const signIn = (loginId: string) => login({ loginId, password: PASSWORD }, `ip-${loginId}`);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-signup-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("self sign-up", () => {
  it("a Retailer works at once: next RT ID, active, can sign in", async () => {
    const r = await signup(form());
    expect(r).toMatchObject({ loginId: "RT0005", pending: false });
    expect(r.partner).toMatchObject({ id: "RT0005", type: "RETAILER", parentId: "DB0001", active: true, createdBy: null });
    expect(r.partner.approval ?? null).toBeNull();
    expect((await store().users.get("RT0005"))!.passwordHash).toMatch(/^scrypt\$/);
    await expect(signIn("RT0005")).resolves.toMatchObject({ user: { user: expect.objectContaining({ id: "RT0005" }) } });
  });

  it("a Distributor waits for approval; approved, it signs in", async () => {
    const r = await signup(form({ type: "DB", name: "Hadapsar Distributors", parentId: "SS0001" }));
    expect(r).toMatchObject({ loginId: "DB0003", pending: true });
    expect(r.partner).toMatchObject({ approval: "PENDING", active: false });
    expect(r.message).toMatch(/waiting for Velza approval/);
    await expect(signIn("DB0003")).rejects.toMatchObject({ status: 403, code: "PENDING_APPROVAL", message: "Your account is waiting for Velza approval" });
    // Review focus 3: the Active box cannot get round the approval.
    await expect(updateEntity("AD0001", "partners", "DB0003", { active: true })).rejects.toMatchObject({ code: "NOT_APPROVED" });
    // Review focus 2: a pending Distributor cannot be picked as a Retailer's parent, and is not offered.
    await expect(signup(form({ parentId: "DB0003" }))).rejects.toMatchObject({ code: "BAD_PARENT" });
    expect((await signupOptions()).distributors.map((d) => d.id)).not.toContain("DB0003");
    // Only Velza Admin decides.
    await expect(decideApproval("SS0001", "DB0003", { decision: "approve" })).rejects.toMatchObject({ status: 403 });
    const a = await decideApproval("AD0001", "DB0003", { decision: "approve" });
    expect(a.partner).toMatchObject({ id: "DB0003", active: true });
    expect(a.partner.approval ?? null).toBeNull();
    expect((await store().users.get("DB0003"))!.active).toBe(true);
    await expect(signIn("DB0003")).resolves.toMatchObject({ user: { user: expect.objectContaining({ id: "DB0003" }) } });
    expect((await signupOptions()).distributors.map((d) => d.id)).toContain("DB0003");
    // Review focus 4: deciding again is refused.
    await expect(decideApproval("AD0001", "DB0003", { decision: "reject" })).rejects.toMatchObject({ code: "NOT_PENDING" });
  });

  it("a rejected Super Stockist never signs in and no longer holds its state", async () => {
    expect((await signupOptions()).statesTaken).toEqual(expect.arrayContaining(["Maharashtra", "Karnataka"]));
    const r = await signup(form({ type: "SS", name: "Goa Super Stockist", city: "Panaji", state: "Goa", pincode: "403001", parentId: null }));
    expect(r).toMatchObject({ loginId: "SS0003", pending: true });
    expect((await signupOptions()).statesTaken).toContain("Goa"); // a pending SS holds the state
    await decideApproval("AD0001", "SS0003", { decision: "reject" });
    expect(await store().partners.get("SS0003")).toMatchObject({ approval: "REJECTED", active: false });
    await expect(signIn("SS0003")).rejects.toMatchObject({ status: 403, code: "REJECTED", message: "This sign-up was not approved. Contact Velza." });
    await expect(updateEntity("AD0001", "partners", "SS0003", { active: true })).rejects.toMatchObject({ code: "NOT_APPROVED" });
    // Review focus 1: the state is free again.
    expect((await signupOptions()).statesTaken).not.toContain("Goa");
    const again = await signup(form({ type: "SS", name: "Goa SS (second try)", city: "Margao", state: "Goa", pincode: "403601", parentId: null }));
    expect(again.loginId).toBe("SS0004"); // IDs are never reused
  });

  it("checks the form like the Admin's: type, parent, state, password, duplicates", async () => {
    // Review focus 5: only SS, DB and Retailer can sign themselves up.
    for (const type of ["MANUFACTURER", "WAREHOUSE"]) await expect(signup(form({ type, parentId: null }))).rejects.toThrow(/Invalid option/);
    await expect(signup(form({ parentId: null }))).rejects.toMatchObject({ code: "BAD_PARENT" }); // a Retailer must pick its supplier
    await expect(signup(form({ type: "DB", parentId: null }))).rejects.toMatchObject({ code: "BAD_PARENT" });
    await expect(signup(form({ type: "DB", parentId: "DB0001" }))).rejects.toMatchObject({ code: "BAD_PARENT" });
    await expect(signup(form({ type: "SS", state: "Maharashtra", parentId: null }))).rejects.toMatchObject({ code: "STATE_TAKEN" });
    await expect(signup(form({ state: "" }))).rejects.toMatchObject({ code: "BAD_STATE" });
    await expect(signup(form({ password: "short" }))).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    const taken = (await store().partners.get("RT0001"))!.phone;
    await expect(signup(form({ phone: taken }))).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("offers only approved, active parents, with name and city only", async () => {
    const o = await signupOptions();
    expect(o.superStockists.map((s) => s.id)).toEqual(["SS0001", "SS0002"]); // not the pending/rejected Goa sign-ups
    expect(Object.keys(o.superStockists[0]).sort()).toEqual(["city", "id", "name", "state"]);
    expect(Object.keys(o.distributors[0]).sort()).toEqual(["city", "id", "name", "parentId"]);
  });
});
