// Partner registration by Velza Admin (IDs in sequence, sign-ins, one SS per state) and sign-in:
// passwords set by the Admin, changed only by their owner, each sign-in seeing only its own data.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getStore } from "@/lib/store";
import { bootstrap, createEntity, deleteEntity, listEntity, updateEntity } from "@/lib/services/admin";
import { changePassword, devDefaultUserId, devLogin, devUsers, login, me, sessionUserId } from "@/lib/services/auth";
import { buildSampleSeed, SAMPLE_PASSWORD } from "../fixtures/sampleNetwork";

let dir: string;
const store = () => getStore();
let phone = 9300000000;

const form = (over: Record<string, unknown> = {}) => ({
  type: "DB",
  name: "FC Road Distributors",
  place: "FC Road",
  address: "Shop 12, FC Road",
  city: "Pune",
  state: "Maharashtra",
  pincode: "411004",
  contactPerson: "Asha Patil",
  phone: `+91 ${phone++}`,
  email: "",
  parentId: "SS0001",
  password: "First2026pass",
  ...over,
});
const register = async (over: Record<string, unknown> = {}) =>
  (await createEntity("AD0001", "partners", form(over))) as { partner: { id: string }; logins: { id: string; role: string; passwordHash?: unknown }[]; message: string };

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-registration-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("registration form", () => {
  it("gives each partner the next ID of its role and a sign-in with the same ID", async () => {
    // The sample network already has DB0001 and DB0002.
    const r = await register();
    expect(r.partner).toMatchObject({ id: "DB0003", place: "FC Road", state: "Maharashtra", contactPerson: "Asha Patil", parentId: "SS0001", createdBy: "AD0001" });
    expect(r.logins).toEqual([expect.objectContaining({ id: "DB0003", role: "DB", partnerId: "DB0003", hasPassword: true })]);
    expect(r.logins[0].passwordHash).toBeUndefined();
    expect(r.message).toMatch(/as DB0003 — sign-in DB0003/);
    // The sample network has RT0001–RT0004.
    expect((await register({ type: "RETAILER", name: "Deccan Gymkhana Store", parentId: "DB0001" })).partner).toMatchObject({ id: "RT0005", parentId: "DB0001" });
  });

  it("a Retailer is assigned to a Distributor, or to a Super Stockist directly", async () => {
    const r = await register({ type: "RETAILER", name: "Camp Kirana", parentId: "SS0001" });
    expect(r.partner).toMatchObject({ id: "RT0006", type: "RETAILER", parentId: "SS0001" });
    expect(r.logins).toEqual([expect.objectContaining({ id: "RT0006", role: "RETAILER", partnerId: "RT0006" })]);
    await expect(register({ type: "RETAILER", parentId: "MF0001" })).rejects.toThrow(/A Retailer must be assigned to a Distributor or Super Stockist/);
    await expect(register({ type: "RETAILER", parentId: "RT0001" })).rejects.toThrow(/must be assigned to a Distributor or Super Stockist/);
    await expect(register({ type: "RETAILER", parentId: "XX9999" })).rejects.toThrow(/must be assigned to a Distributor or Super Stockist/);
    // Reassigning works the same way: from a Distributor to a Super Stockist and back.
    await expect(updateEntity("AD0001", "partners", "RT0006", { parentId: "DB0002" })).resolves.toMatchObject({ parentId: "DB0002" });
    await expect(updateEntity("AD0001", "partners", "RT0006", { parentId: "SS0002" })).resolves.toMatchObject({ parentId: "SS0002" });
    await expect(updateEntity("AD0001", "partners", "RT0006", { parentId: "MF0001" })).rejects.toThrow(/must be assigned to a Distributor or Super Stockist/);
  });

  it("there are no Supplier or Outlet tiers any more", async () => {
    for (const type of ["SUPPLIER", "OUTLET"]) {
      await expect(register({ type, parentId: "DB0001" })).rejects.toThrow(/Invalid option: expected one of .*RETAILER/);
    }
    await expect(createEntity("AD0001", "users", { name: "x", role: "OUTLET", partnerId: "RT0001", password: "Again2026pass" })).rejects.toThrow(/Invalid option/);
  });

  it("never reuses a number, even after a delete", async () => {
    const { partner } = await register();
    expect(partner.id).toBe("DB0004");
    await deleteEntity("AD0001", "partners", partner.id);
    expect((await register()).partner.id).toBe("DB0005");
  });

  it("the plant gets two sign-ins, Operator and QC, each with its own password", async () => {
    const r = await register({ type: "MANUFACTURER", name: "Plant 2", state: "Gujarat", parentId: null, password: "Operator2026", qcPassword: "Quality2026" });
    expect(r.partner.id).toBe("MF0002");
    expect(r.logins.map((u) => [u.id, u.role])).toEqual([
      ["MF0002-OP", "OPERATOR"],
      ["MF0002-QC", "QC"],
    ]);
    await expect(login({ loginId: "MF0002-QC", password: "Operator2026" })).rejects.toMatchObject({ status: 401 });
    expect((await login({ loginId: "mf0002-qc", password: "Quality2026" })).user.user).toMatchObject({ id: "MF0002-QC", role: "QC" });
    await expect(register({ type: "MANUFACTURER", name: "Plant 3", parentId: null, qcPassword: undefined })).rejects.toThrow(/QC password: a password is required/);
  });

  it("allows one Super Stockist per state", async () => {
    // SS0001 is Maharashtra, SS0002 Karnataka.
    await expect(register({ type: "SS", name: "Second Maharashtra SS", parentId: null })).rejects.toThrow(/Maharashtra already has a Super Stockist: SS-1 .*\(SS0001\)/);
    expect((await register({ type: "SS", name: "Gujarat SS", state: "Gujarat", parentId: null })).partner.id).toBe("SS0003");
    // Moving an SS into a state that has one is refused too.
    await expect(updateEntity("AD0001", "partners", "SS0003", { state: "Karnataka" })).rejects.toThrow(/Karnataka already has/);
  });

  it("checks the form", async () => {
    await expect(register({ state: "" })).rejects.toThrow(/Pick the state/);
    await expect(register({ state: "Atlantis" })).rejects.toThrow(/Pick the state/);
    await expect(register({ pincode: "4110" })).rejects.toThrow(/PIN code must be 6 digits/);
    await expect(register({ phone: "call me" })).rejects.toThrow(/Phone/);
    await expect(register({ phone: "+91-980000001" })).rejects.toThrow(/already used by SS-1/); // SS-1's phone, typed differently
    await expect(register({ email: "not-an-email" })).rejects.toThrow(/not an email/);
    await expect(register({ password: "short1" })).rejects.toThrow(/at least 8/);
    await expect(register({ password: "lettersonly" })).rejects.toThrow(/letters and digits/);
    await expect(register({ parentId: "DB0001" })).rejects.toThrow(/must be assigned to a Super Stockist/);
    await expect(register({ address: "" })).rejects.toThrow();
  });

  it("the same phone with or without +91 or a leading 0 counts as one number", async () => {
    const first = await register({ name: "Phone Check Distributors", phone: "+91 98765 11111" });
    const taken = new RegExp(`already used by Phone Check Distributors \\(${first.partner.id}\\)`);
    for (const variant of ["9876511111", "098765 11111", "919876511111", "+91-98765-11111"]) await expect(register({ phone: variant }), variant).rejects.toThrow(taken);
    // The other way round: a bare number first, then with +91. Numbers are stored as typed.
    const r = await register({ phone: "9876522222" });
    expect(await store().partners.get(r.partner.id)).toMatchObject({ phone: "9876522222" });
    await expect(register({ phone: "+91 98765 22222" })).rejects.toThrow(new RegExp(`already used by .*\\(${r.partner.id}\\)`));
    // A different number is fine.
    await expect(register({ phone: "+91 98765 33333" })).resolves.toMatchObject({ partner: { phone: "+91 98765 33333" } });
  });

  it("the tier and a sign-in's role are part of the ID and can't change", async () => {
    await expect(updateEntity("AD0001", "partners", "DB0001", { type: "SS" })).rejects.toThrow(/tier is part of its ID/);
    await expect(updateEntity("AD0001", "users", "DB0001", { role: "SS" })).rejects.toThrow(/tied to its role and partner/);
    await expect(updateEntity("AD0001", "partners", "DB0001", { phone: "+91 98111 22233", place: "Wagle Estate Rd 2" })).resolves.toMatchObject({ phone: "+91 98111 22233" });
  });

  it("only Velza Admin can register", async () => {
    for (const who of ["HQ0001", "SS0001", "MF0001-OP"]) await expect(createEntity(who, "partners", form())).rejects.toMatchObject({ status: 403 });
  });

  it("Admin adds Velza staff sign-ins from their own sequence", async () => {
    expect(await createEntity("AD0001", "users", { name: "Second Admin", role: "ADMIN", password: "Admin2026pass" })).toMatchObject({ id: "AD0002", hasPassword: true });
    expect(await createEntity("AD0001", "users", { name: "HQ analyst", role: "TRACE_OWNER", password: "Analyst2026" })).toMatchObject({ id: "HQ0002" });
    // A partner sign-in that was deleted can be made again; its ID comes from the partner.
    await expect(createEntity("AD0001", "users", { name: "x", role: "SS", partnerId: "SS0001", password: "Again2026pass" })).rejects.toThrow(/SS0001 already exists/);
    expect(((await listEntity("AD0001", "users")) as Record<string, unknown>[]).some((u) => "passwordHash" in u)).toBe(false);
  });

  it("a Velza staff sign-in with a partner is refused (not silently stripped), and no staff number is used up", async () => {
    const before = (await store().users.list({ role: "ADMIN" })).length;
    await expect(createEntity("AD0001", "users", { name: "x", role: "ADMIN", partnerId: "SS0001", password: "Admin2026pass" })).rejects.toMatchObject({
      code: "BAD_PARTNER",
      message: expect.stringMatching(/Velza staff and has no partner/),
    });
    expect((await store().users.list({ role: "ADMIN" })).length).toBe(before);
    // The next staff sign-in still gets the next number in sequence.
    expect(await createEntity("AD0001", "users", { name: "Third Admin", role: "ADMIN", partnerId: null, password: "Admin2026pass" })).toMatchObject({ id: "AD0003" });
  });
});

describe("sign-in", () => {
  it("signs in with the sign-in ID (any case) and the password the Admin shared", async () => {
    const r = await login({ loginId: " db0001 ", password: SAMPLE_PASSWORD });
    expect(r.user).toMatchObject({ user: { id: "DB0001", role: "DB" }, partner: { id: "DB0001" }, organisation: "DB-1 Thane Distributors" });
    expect(await sessionUserId(r.token)).toBe("DB0001");
    expect((await store().users.get("DB0001"))?.lastLoginAt).toBeTruthy();
    await expect(login({ loginId: "DB0001", password: "wrong-pass1" })).rejects.toMatchObject({ status: 401, code: "BAD_CREDENTIALS" });
    await expect(login({ loginId: "DB9999", password: SAMPLE_PASSWORD })).rejects.toMatchObject({ status: 401, code: "BAD_CREDENTIALS" });
  });

  it("locks a sign-in ID for a few minutes after 5 wrong passwords", async () => {
    for (let i = 0; i < 5; i++) await expect(login({ loginId: "RT0003", password: "nope-nope1" })).rejects.toMatchObject({ status: 401 });
    await expect(login({ loginId: "RT0003", password: SAMPLE_PASSWORD })).rejects.toMatchObject({ status: 429, code: "LOCKED" });
  });

  it("the lock is per sign-in ID and client IP: wrong guesses from one place don't lock the real person out elsewhere", async () => {
    for (let i = 0; i < 5; i++) await expect(login({ loginId: "AD0001", password: "nope-nope1" }, "198.51.100.7")).rejects.toMatchObject({ status: 401 });
    await expect(login({ loginId: "AD0001", password: SAMPLE_PASSWORD }, "198.51.100.7")).rejects.toMatchObject({ status: 429, code: "LOCKED" });
    // The Admin at the office signs in normally.
    expect((await login({ loginId: "AD0001", password: SAMPLE_PASSWORD }, "203.0.113.20")).user.user.id).toBe("AD0001");
  });

  it("without a trusted client-IP header, a fake IP per guess still hits the per-ID backstop (20 from any IP)", async () => {
    vi.stubEnv("CLIENT_IP_HEADER", "");
    try {
      for (let i = 0; i < 20; i++) {
        await expect(login({ loginId: "AD0999", password: "nope-nope1" }, `198.51.100.${100 + i}`)).rejects.toMatchObject({ status: 401 });
      }
      // A brand-new fake IP no longer helps: the ID itself is locked for the lock period.
      await expect(login({ loginId: "AD0999", password: "nope-nope1" }, "203.0.113.250")).rejects.toMatchObject({ status: 429, code: "LOCKED" });
      // Other sign-ins are untouched.
      await expect(login({ loginId: "AD0998", password: "nope-nope1" }, "203.0.113.250")).rejects.toMatchObject({ status: 401 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("behind a trusted client-IP header, guesses from other IPs never lock the real person out", async () => {
    vi.stubEnv("CLIENT_IP_HEADER", "x-real-ip");
    try {
      for (let i = 0; i < 25; i++) {
        await expect(login({ loginId: "HQ0001", password: "nope-nope1" }, `198.51.100.${150 + i}`)).rejects.toMatchObject({ status: 401 });
      }
      expect((await login({ loginId: "HQ0001", password: SAMPLE_PASSWORD }, "203.0.113.21")).user.user.id).toBe("HQ0001");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("after the lock runs out the count starts again (one more wrong password is 401, not an instant re-lock)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const ip = "198.51.100.8";
      for (let i = 0; i < 5; i++) await expect(login({ loginId: "DB0002", password: "nope-nope1" }, ip)).rejects.toMatchObject({ status: 401 });
      await expect(login({ loginId: "DB0002", password: "nope-nope1" }, ip)).rejects.toMatchObject({ status: 429 });
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
      await expect(login({ loginId: "DB0002", password: "nope-nope1" }, ip)).rejects.toMatchObject({ status: 401, code: "BAD_CREDENTIALS" });
      for (let i = 0; i < 3; i++) await expect(login({ loginId: "DB0002", password: "nope-nope1" }, ip)).rejects.toMatchObject({ status: 401 });
      // A success clears the count: four more wrong ones are still 401, not locked.
      await login({ loginId: "DB0002", password: SAMPLE_PASSWORD }, ip);
      for (let i = 0; i < 4; i++) await expect(login({ loginId: "DB0002", password: "nope-nope1" }, ip)).rejects.toMatchObject({ status: 401 });
      await login({ loginId: "DB0002", password: SAMPLE_PASSWORD }, ip);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a person changes only their own password; their other sessions are signed out", async () => {
    const a = await login({ loginId: "RT0001", password: SAMPLE_PASSWORD });
    const b = await login({ loginId: "RT0001", password: SAMPLE_PASSWORD });
    await expect(changePassword("RT0001", a.token, { currentPassword: "wrong", newPassword: "Mine2026pass" })).rejects.toThrow(/Current password is wrong/);
    await expect(changePassword("RT0001", a.token, { currentPassword: SAMPLE_PASSWORD, newPassword: "short" })).rejects.toThrow(/at least 8/);
    expect(await changePassword("RT0001", a.token, { currentPassword: SAMPLE_PASSWORD, newPassword: "Mine2026pass" })).toMatchObject({ ok: true });
    expect(await sessionUserId(a.token)).toBe("RT0001");
    expect(await sessionUserId(b.token)).toBeNull();
    await expect(login({ loginId: "RT0001", password: SAMPLE_PASSWORD })).rejects.toMatchObject({ status: 401 });
    await login({ loginId: "RT0001", password: "Mine2026pass" });
    // Nothing else about their account: the admin screens are closed to them.
    await expect(updateEntity("RT0001", "users", "RT0001", { name: "Me" })).rejects.toMatchObject({ status: 403 });
  });

  it("a new password from the Admin signs the person out everywhere", async () => {
    const s = await login({ loginId: "RT0002", password: SAMPLE_PASSWORD });
    await updateEntity("AD0001", "users", "RT0002", { password: "Reset2026pass" });
    expect(await sessionUserId(s.token)).toBeNull();
    await login({ loginId: "RT0002", password: "Reset2026pass" });
  });

  it("a deactivated sign-in or partner can't sign in, and an open session stops working", async () => {
    const s = await login({ loginId: "RT0004", password: SAMPLE_PASSWORD });
    await updateEntity("AD0001", "partners", "RT0004", { active: false });
    await expect(me(await sessionUserId(s.token))).rejects.toMatchObject({ status: 401 });
    await expect(login({ loginId: "RT0004", password: SAMPLE_PASSWORD })).rejects.toMatchObject({ status: 403, code: "DISABLED" });
    await updateEntity("AD0001", "partners", "RT0004", { active: true });
    await updateEntity("AD0001", "users", "RT0004", { active: false });
    await expect(login({ loginId: "RT0004", password: SAMPLE_PASSWORD })).rejects.toMatchObject({ status: 403 });
  });

  it("each sign-in sees only its own partner; Velza staff see all", async () => {
    const mine = await bootstrap("DB0001");
    expect(mine.partners.map((p) => p.id)).toEqual(["DB0001"]);
    expect(mine).not.toHaveProperty("users");
    expect((await bootstrap("MF0001-OP")).devices).toHaveLength(1);
    expect((await bootstrap("DB0002")).devices).toHaveLength(0);
    expect((await bootstrap("HQ0001")).partners.length).toBeGreaterThan(10);
    // Settings are Admin configuration: only the Admin's bootstrap carries them.
    for (const who of ["DB0001", "MF0001-OP", "HQ0001"]) expect(await bootstrap(who)).not.toHaveProperty("settings");
    expect(await bootstrap("AD0001")).toMatchObject({ settings: { publicBaseUrl: expect.any(String) } });
    await expect(bootstrap(null)).rejects.toMatchObject({ status: 401, code: "NOT_SIGNED_IN" });
  });
});

describe("while sign-in is off (development)", () => {
  afterAll(() => {
    delete process.env.SIGN_IN;
  });

  it("anyone active can be acted as, no password", async () => {
    process.env.SIGN_IN = "off";
    const people = await devUsers();
    expect(people).toEqual(expect.arrayContaining([expect.objectContaining({ id: "SS0002", role: "SS", partnerName: "SS-2 Deccan Super Stockist" })]));
    expect(people.some((u) => "passwordHash" in u)).toBe(false);
    expect(people.map((u) => u.id)).not.toContain("RT0004"); // deactivated earlier in this file
    const s = await devLogin({ userId: "SS0002" });
    expect(await sessionUserId(s.token)).toBe("SS0002");
    await expect(devLogin({ userId: "RT0004" })).rejects.toMatchObject({ status: 401 });
  });

  it("without a session the app acts as the Velza Admin, and writes nothing", async () => {
    process.env.SIGN_IN = "off";
    const sessions = (await store().sessions.list()).length;
    expect(await devDefaultUserId()).toBe("AD0001");
    expect((await me("AD0001")).user.role).toBe("ADMIN");
    expect((await store().sessions.list()).length).toBe(sessions);
  });

  it("is refused as soon as sign-in is on", async () => {
    process.env.SIGN_IN = "on";
    await expect(devUsers()).rejects.toMatchObject({ status: 404 });
    await expect(devLogin({ userId: "AD0001" })).rejects.toMatchObject({ status: 404 });
    expect(await devDefaultUserId()).toBeNull();
  });
});
