// Sign-in, Admin + HQ approval, one portal per role, Super Stockist territories, admin deletes.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { buildBaseSeed, DEFAULT_SEED_PASSWORD } from "@/lib/store/seedData";
import { approvalAction, bootstrap, createEntity, deleteEntity, listApprovals, listEntity, updateEntity } from "@/lib/services/admin";
import { changePassword, login, logout, me, sessionUserId } from "@/lib/services/auth";
import { destinations, dispatch, myDistributors } from "@/lib/services/movement";
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
  await store().reset(buildBaseSeed());
  ids.admin = await userId("ADMIN");
  ids.hq = await userId("TRACE_OWNER");
  ids.ss1 = await userId("SS", "SS-1");
  ids.ss2 = await userId("SS", "SS-2");
  ids.operator = await userId("OPERATOR");
  ids.SS1 = await partnerId("SS-1");
  ids.SS2 = await partnerId("SS-2");
  ids.DB1 = await partnerId("DB-1");
  ids.DB2 = await partnerId("DB-2");
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("sign in", () => {
  it("signs in with sign-in ID + password and creates a hashed session", async () => {
    const r = await login({ loginId: " SS1 ", password: DEFAULT_SEED_PASSWORD });
    expect(r.user.user).toMatchObject({ loginId: "ss1", role: "SS" });
    expect(r.user.user).not.toHaveProperty("passwordHash");
    expect(await sessionUserId(r.token)).toBe(ids.ss1);
    const sessions = await store().sessions.list();
    expect(sessions.some((s) => s.id === r.token)).toBe(false); // stored as a hash, not the token
    await logout(r.token);
    expect(await sessionUserId(r.token)).toBeNull();
  });

  it("rejects a wrong password and never stores plain passwords", async () => {
    await expect(login({ loginId: "ss1", password: "nope12345" })).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
    await expect(login({ loginId: "nobody", password: "nope12345" })).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
    const raw = await fs.readFile(process.env.VELZA_DB_PATH!, "utf8");
    expect(raw).not.toContain(DEFAULT_SEED_PASSWORD);
  });

  it("locks a sign-in ID after 5 wrong passwords", async () => {
    for (let i = 0; i < 5; i++) await expect(login({ loginId: "outlet3", password: "wrong1234" })).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
    await expect(login({ loginId: "outlet3", password: DEFAULT_SEED_PASSWORD })).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("lets a user change their own password", async () => {
    await expect(changePassword(ids.ss2, { currentPassword: "wrong", newPassword: "NewPass123" })).rejects.toThrow(/Current password/);
    await expect(changePassword(ids.ss2, { currentPassword: DEFAULT_SEED_PASSWORD, newPassword: "short" })).rejects.toThrow(/at least 8/);
    await changePassword(ids.ss2, { currentPassword: DEFAULT_SEED_PASSWORD, newPassword: "NewPass123" });
    await expect(login({ loginId: "ss2", password: DEFAULT_SEED_PASSWORD })).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
    expect((await login({ loginId: "ss2", password: "NewPass123" })).user.user.id).toBe(ids.ss2);
  });
});

describe("Admin sets up accounts, HQ approves", () => {
  let newId: string;

  it("Admin creates a partner account: Admin-approved, waiting for HQ, can't sign in yet", async () => {
    const u = await createEntity(ids.admin, "users", { name: "Nisha (SS-1)", role: "SS", partnerId: ids.SS1, loginId: "Nisha.SS1", password: "Start1234" });
    newId = (u as { id: string }).id;
    expect(u).toMatchObject({ loginId: "nisha.ss1", status: "PENDING_HQ", hasPassword: true });
    expect(u).not.toHaveProperty("passwordHash");
    await expect(login({ loginId: "nisha.ss1", password: "Start1234" })).rejects.toMatchObject({ code: "PENDING_HQ" });
    expect((await listApprovals(ids.hq)).find((r) => r.id === newId)?.status).toBe("PENDING_HQ");
  });

  it("rejects duplicate sign-in IDs and weak passwords", async () => {
    await expect(createEntity(ids.admin, "users", { name: "X", role: "SS", partnerId: ids.SS1, loginId: "NISHA.ss1", password: "Start1234" })).rejects.toThrow(/already used/);
    await expect(createEntity(ids.admin, "users", { name: "X", role: "SS", partnerId: ids.SS1, loginId: "x.ss1", password: "weak" })).rejects.toThrow();
  });

  it("only HQ approves; then the account signs in", async () => {
    await expect(approvalAction(ids.admin, { userId: newId, action: "approve" })).rejects.toMatchObject({ status: 403 });
    await expect(approvalAction(ids.ss1, { userId: newId, action: "approve" })).rejects.toMatchObject({ status: 403 });
    expect(await approvalAction(ids.hq, { userId: newId, action: "approve" })).toMatchObject({ status: "APPROVED" });
    expect((await login({ loginId: "nisha.ss1", password: "Start1234" })).user.user.id).toBe(newId);
  });

  it("changing the partner sends the account back to HQ", async () => {
    const u = await updateEntity(ids.admin, "users", newId, { partnerId: ids.SS2 });
    expect(u).toMatchObject({ status: "PENDING_HQ" });
    await expect(me(newId)).rejects.toMatchObject({ code: "NOT_SIGNED_IN" });
    await approvalAction(ids.hq, { userId: newId, action: "approve" });
  });

  it("HQ revoke needs a reason, blocks at once; Admin can resubmit", async () => {
    await expect(approvalAction(ids.hq, { userId: newId, action: "revoke" })).rejects.toThrow(/reason/);
    expect(await approvalAction(ids.hq, { userId: newId, action: "revoke", reason: "Left the company" })).toMatchObject({ status: "REJECTED" });
    await expect(me(newId)).rejects.toMatchObject({ code: "NOT_SIGNED_IN" });
    expect(await approvalAction(ids.admin, { userId: newId, action: "resubmit" })).toMatchObject({ status: "PENDING_HQ" });
  });

  it("Velza staff accounts need no approval; the Admin can't lock themselves out", async () => {
    const hq2 = await createEntity(ids.admin, "users", { name: "Meera (HQ)", role: "TRACE_OWNER", loginId: "meera.hq", password: "Start1234" });
    expect(hq2).toMatchObject({ status: "APPROVED", partnerId: null });
    await expect(updateEntity(ids.admin, "users", ids.admin, { active: false })).rejects.toThrow(/your own account/);
    await expect(deleteEntity(ids.admin, "users", ids.admin)).rejects.toThrow(/your own account/);
  });

  it("disabling a user signs them out everywhere", async () => {
    const { token } = await login({ loginId: "db2", password: DEFAULT_SEED_PASSWORD });
    const db2 = await userId("DB", "DB-2");
    await updateEntity(ids.admin, "users", db2, { active: false });
    expect(await sessionUserId(token)).toBeNull();
    await updateEntity(ids.admin, "users", db2, { active: true });
  });
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
    await expect(listApprovals(ids.ss1)).rejects.toMatchObject({ status: 403 });
  });

  it("not signed in → 401", async () => {
    await expect(bootstrap(null)).rejects.toMatchObject({ status: 401 });
  });

  it("a partner user only receives its own partner in reference data", async () => {
    const b = await bootstrap(ids.ss1);
    expect(b.partners.map((p) => p.id)).toEqual([ids.SS1]);
    expect(b).not.toHaveProperty("users");
    expect((await bootstrap(ids.admin)).partners.length).toBe(10);
  });
});

describe("Super Stockist territory", () => {
  it("each SS sees and dispatches only to its assigned distributors", async () => {
    expect((await destinations(ids.ss1)).destinations.map((d) => d.id)).toEqual([ids.DB1]);
    expect((await destinations(ids.ss2)).destinations.map((d) => d.id)).toEqual([ids.DB2]);
    expect((await myDistributors(ids.ss1)).distributors.map((d) => d.id)).toEqual([ids.DB1]);
    await expect(myDistributors(ids.operator)).rejects.toMatchObject({ status: 403 });
    const r = await dispatch(ids.ss2, { action: "check", toPartnerId: ids.DB1, invoice: "INV-1", code: "91ZZZZZZOR00001" });
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_CODE" }); // unknown code checked first…
    await expect(dispatch(ids.ss2, { action: "confirm", toPartnerId: ids.DB1, invoice: "INV-1", codes: ["x"] })).rejects.toThrow(/not one of .*assigned distributors/);
  });

  it("Admin reassigns a distributor; only SS can be a parent, only DBs have one", async () => {
    await updateEntity(ids.admin, "partners", ids.DB1, { parentId: ids.SS2 });
    expect((await destinations(ids.ss2)).destinations.map((d) => d.id).sort()).toEqual([ids.DB1, ids.DB2].sort());
    expect((await destinations(ids.ss1)).destinations).toEqual([]);
    await expect(updateEntity(ids.admin, "partners", ids.DB1, { parentId: ids.DB2 })).rejects.toThrow(/Super Stockist/);
    await expect(updateEntity(ids.admin, "partners", ids.SS1, { parentId: ids.SS2 })).rejects.toThrow(/Only distributors/);
    await updateEntity(ids.admin, "partners", ids.DB1, { parentId: ids.SS1 });
  });
});

describe("admin deletes", () => {
  it("deletes unused rows, refuses rows that are in use", async () => {
    const p = (await createEntity(ids.admin, "partners", { type: "OUTLET", name: "Outlet-9 Test", city: "Pune" })) as { id: string };
    expect(await deleteEntity(ids.admin, "partners", p.id)).toMatchObject({ ok: true });
    await expect(deleteEntity(ids.admin, "partners", ids.SS1)).rejects.toThrow(/user\(s\).*assigned distributor/);
    const f = (await createEntity(ids.admin, "flavours", { code: "ZZ", name: "Test" })) as { id: string };
    expect(await deleteEntity(ids.admin, "flavours", f.id)).toMatchObject({ ok: true });
    const country = (await store().countries.list())[0];
    await expect(deleteEntity(ids.admin, "countries", country.id)).rejects.toThrow(/default country/);
    await expect(deleteEntity(ids.ss1, "flavours", f.id)).rejects.toMatchObject({ status: 403 });
  });
});
