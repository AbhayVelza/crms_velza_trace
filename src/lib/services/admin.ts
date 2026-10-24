// Velza Admin: reference data, partners, users (sign-in ID, password, approvals), devices, pools,
// settings, deletes. Velza HQ: approve / reject / revoke partner accounts.

import { z } from "zod";
import { accountStatus, ACCOUNT_STATUS_LABELS, checkLoginId, checkPassword, needsApproval, normalizeLoginId, REAPPROVAL_FIELDS } from "@/lib/core/auth";
import { can } from "@/lib/core/permissions";
import { PARTNER_TYPES, ROLE_PARTNER_TYPE, ROLES, type Partner, type Settings, type User } from "@/lib/core/types";
import { hashPassword } from "@/lib/passwords";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, loadActor, notFound, nowIso, publicUser, requireAction, type Actor } from "./common";
import { autoRefill, issueCodes, reservedCodes } from "./pool";

const ruleField = (check: (s: string) => string | null) =>
  z.string().superRefine((s, ctx) => {
    const message = check(s);
    if (message) ctx.addIssue({ code: "custom", message });
  });
const loginIdField = ruleField(checkLoginId);
const passwordField = ruleField(checkPassword);

export const ENTITY_SCHEMAS = {
  partners: z.object({
    type: z.enum(PARTNER_TYPES),
    name: z.string().trim().min(1).max(100),
    city: z.string().trim().min(1).max(60),
    territory: z.string().trim().max(120).optional(),
    parentId: z.string().nullable().optional(),
    active: z.boolean().optional(),
  }),
  users: z.object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(ROLES),
    partnerId: z.string().nullable().optional(),
    loginId: loginIdField,
    password: passwordField,
    active: z.boolean().optional(),
  }),
  devices: z.object({
    manufacturerId: z.string().min(1),
    name: z.string().trim().min(1).max(60),
    offline: z.boolean().optional(),
  }),
  countries: z.object({
    code: z.string().regex(/^[0-9]{2}$/, "Country code must be 2 digits"),
    name: z.string().trim().min(1).max(60),
    active: z.boolean().optional(),
  }),
  flavours: z.object({
    code: z.string().regex(/^[A-Z]{2}$/, "Flavour code must be 2 uppercase letters"),
    name: z.string().trim().min(1).max(40),
    active: z.boolean().optional(),
  }),
} as const;

export type AdminEntity = keyof typeof ENTITY_SCHEMAS;
export const ADMIN_ENTITIES = Object.keys(ENTITY_SCHEMAS) as AdminEntity[];

export function isAdminEntity(s: string): s is AdminEntity {
  return (ADMIN_ENTITIES as string[]).includes(s);
}

async function validateEntity(tx: StoreTx, entity: AdminEntity, data: Record<string, unknown>, selfId?: string) {
  if (entity === "users") {
    const role = data.role as (typeof ROLES)[number];
    const needType = ROLE_PARTNER_TYPE[role];
    if (needType) {
      const partner = data.partnerId ? await tx.partners.get(String(data.partnerId)) : null;
      if (!partner || partner.type !== needType) {
        throw badRequest("BAD_PARTNER", `A ${role} user must belong to a ${needType} partner`);
      }
    } else if (data.partnerId) {
      throw badRequest("BAD_PARTNER", `A ${role} user is Velza staff and has no partner`);
    }
    const taken = await tx.users.findOne({ loginId: String(data.loginId) });
    if (taken && taken.id !== selfId) throw badRequest("DUPLICATE", `Sign-in ID ${data.loginId} is already used by ${taken.name}`);
  }
  if (entity === "devices") {
    const m = await tx.partners.get(String(data.manufacturerId));
    if (!m || m.type !== "MANUFACTURER") throw badRequest("BAD_PARTNER", "Devices belong to a manufacturer");
  }
  if (entity === "countries" || entity === "flavours") {
    const rows = await tx[entity].list({ code: data.code as string });
    if (rows.some((r) => r.id !== selfId)) throw badRequest("DUPLICATE", `Code ${data.code} already exists`);
  }
  if (entity === "partners") {
    if (data.parentId) {
      if (data.type !== "DB") throw badRequest("BAD_PARENT", "Only distributors are assigned to a Super Stockist");
      const parent = await tx.partners.get(String(data.parentId));
      if (!parent || parent.type !== "SS") throw badRequest("BAD_PARENT", "A distributor must be assigned to a Super Stockist");
    }
    if (selfId) {
      const current = await tx.partners.get(selfId);
      if (current && current.type !== data.type) {
        const users = await tx.users.list({ partnerId: selfId });
        if (users.length) throw badRequest("IN_USE", "Cannot change the tier of a partner that has users");
      }
    }
  }
}

/** Never let the Admin lock everyone out. */
async function guardAdmins(tx: StoreTx, actor: Actor, target: User, next: Partial<User> | null) {
  const stillAdmin = next !== null && (next.role ?? target.role) === "ADMIN" && (next.active ?? target.active);
  if (target.id === actor.user.id && !stillAdmin) throw badRequest("SELF", "You cannot disable, delete or change the role of your own account");
  if (target.role === "ADMIN" && !stillAdmin) {
    const admins = (await tx.users.list({ role: "ADMIN", active: true })).filter((u) => u.id !== target.id);
    if (!admins.length) throw badRequest("LAST_ADMIN", "At least one active Velza Admin must remain");
  }
}

export function userView(u: User, users: User[]) {
  const pub = publicUser(u);
  const status = accountStatus(pub);
  const name = (id: string | null) => (id ? (users.find((x) => x.id === id)?.name ?? id) : null);
  return {
    ...pub,
    status,
    statusLabel: ACCOUNT_STATUS_LABELS[status],
    adminApprovedByName: name(u.adminApprovedBy),
    hqApprovedByName: name(u.hqApprovedBy),
    rejectedByName: name(u.rejectedBy),
  };
}

export async function listEntity(userId: string | null, entity: AdminEntity) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "admin");
  if (entity === "users") {
    const users = await store.users.list();
    return users.map((u) => userView(u, users));
  }
  return store[entity].list();
}

export async function createEntity(userId: string | null, entity: AdminEntity, body: unknown) {
  const data = ENTITY_SCHEMAS[entity].parse(body);
  const passwordHash = entity === "users" ? await hashPassword((data as { password: string }).password) : null;
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "admin");
    if (entity === "users") {
      const { name, role, partnerId, loginId, active } = data as z.infer<typeof ENTITY_SCHEMAS.users>;
      const at = nowIso();
      const row: User = {
        id: crypto.randomUUID(),
        name,
        role,
        partnerId: partnerId ?? null,
        active: active ?? true,
        loginId: normalizeLoginId(loginId),
        passwordHash,
        createdAt: at,
        // Created by the Admin = approved by the Admin; partner accounts then wait for HQ.
        adminApprovedBy: needsApproval(role) ? actor.user.id : null,
        adminApprovedAt: needsApproval(role) ? at : null,
        hqApprovedBy: null,
        hqApprovedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectReason: null,
      };
      await validateEntity(tx, entity, { ...row });
      const created = await tx.users.create(row);
      return userView(created, await tx.users.list());
    }
    await validateEntity(tx, entity, { partnerId: null, parentId: null, ...data });
    const defaults =
      entity === "devices" ? { offline: false, lastSyncAt: null } : entity === "partners" ? { active: true, territory: "", parentId: null } : { active: true };
    const row = { ...defaults, ...data, id: crypto.randomUUID() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await (tx[entity] as any).create(row);
    if (entity === "devices") await autoRefill(tx, created.id);
    return created;
  });
}

export async function updateEntity(userId: string | null, entity: AdminEntity, id: string, body: unknown) {
  const patch: Record<string, unknown> = ENTITY_SCHEMAS[entity].partial().parse(body);
  if (entity === "users") {
    if (typeof patch.loginId === "string") patch.loginId = normalizeLoginId(patch.loginId);
    if (typeof patch.password === "string") patch.passwordHash = await hashPassword(patch.password);
    delete patch.password;
  }
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = tx[entity] as any;
    const current = await repo.get(id);
    if (!current) throw notFound(`${entity} ${id}`);
    if ((entity === "countries" || entity === "flavours") && patch.code && patch.code !== current.code) {
      throw badRequest("CODE_LOCKED", "Codes are used inside printed stickers and cannot be changed; add a new entry instead");
    }
    if (entity === "partners" && patch.type && patch.type !== "DB") patch.parentId = null;
    if (entity === "users") {
      const user = current as User;
      await guardAdmins(tx, actor, user, patch as Partial<User>);
      const role = (patch.role as User["role"]) ?? user.role;
      if (!ROLE_PARTNER_TYPE[role]) patch.partnerId = null;
      // A new role or partner is a different access grant: back to HQ for approval.
      const changed = REAPPROVAL_FIELDS.some((k) => k in patch && patch[k] !== user[k]);
      if (changed && needsApproval(role)) {
        Object.assign(patch, { adminApprovedBy: actor.user.id, adminApprovedAt: nowIso(), hqApprovedBy: null, hqApprovedAt: null, rejectedBy: null, rejectedAt: null, rejectReason: null });
      }
    }
    await validateEntity(tx, entity, { ...current, ...patch }, id);
    const updated = await repo.update(id, patch);
    if (entity === "devices" && current.offline && patch.offline === false) await autoRefill(tx, id);
    if (entity === "users") {
      // Disabled accounts are signed out everywhere.
      if (patch.active === false) for (const s of await tx.sessions.list({ userId: id })) await tx.sessions.delete(s.id);
      return userView(updated, await tx.users.list());
    }
    return updated;
  });
}

// ---------------------------------------------------------------- delete

/** Rows referenced by history can't be deleted (the ledger is permanent) — deactivate them instead. */
async function referencesTo(tx: StoreTx, entity: AdminEntity, row: Record<string, unknown>): Promise<string[]> {
  const id = String(row.id);
  const found: string[] = [];
  const add = (n: number, what: string) => n && found.push(`${n} ${what}`);
  if (entity === "partners") {
    const [users, devices, children, lots, packs, moves, scans] = await Promise.all([
      tx.users.list({ partnerId: id }),
      tx.devices.list({ manufacturerId: id }),
      tx.partners.list({ parentId: id }),
      tx.lots.list(),
      tx.packs.list(),
      tx.movements.list(),
      tx.scans.list({ partnerId: id }),
    ]);
    add(users.length, "user(s)");
    add(devices.length, "device(s)");
    add(children.length, "assigned distributor(s)");
    add(lots.filter((l) => l.manufacturerId === id || l.locationId === id || l.inTransitToId === id).length, "lot(s)");
    add(packs.filter((p) => p.locationId === id || p.inTransitToId === id).length, "pack(s)");
    add(moves.filter((m) => m.fromId === id || m.toId === id).length, "movement(s)");
    add(scans.length, "scan(s)");
  }
  if (entity === "users") {
    const [moves, scans, batches, orders, reprints] = await Promise.all([
      tx.movements.list({ userId: id }),
      tx.scans.list({ userId: id }),
      tx.batches.list({ createdBy: id }),
      tx.printOrders.list({ createdBy: id }),
      tx.reprints.list({ userId: id }),
    ]);
    add(moves.length, "movement(s)");
    add(scans.length, "scan(s)");
    add(batches.length + orders.length, "batch/print order(s)");
    add(reprints.length, "reprint(s)");
  }
  if (entity === "devices") {
    add((await tx.batches.list({ deviceId: id })).length, "batch(es)");
  }
  if (entity === "countries" || entity === "flavours") {
    const code = String(row.code);
    const batches = await tx.batches.list(entity === "countries" ? { country: code } : { flavour: code });
    add(batches.length, "batch(es)");
    if (entity === "countries" && (await tx.getSettings()).defaultCountry === code) found.push("the default country setting");
  }
  return found;
}

export async function deleteEntity(userId: string | null, entity: AdminEntity, id: string) {
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = tx[entity] as any;
    const current = await repo.get(id);
    if (!current) throw notFound(`${entity} ${id}`);
    if (entity === "users") await guardAdmins(tx, actor, current, null);
    const refs = await referencesTo(tx, entity, current);
    if (refs.length) {
      const hint = entity === "devices" ? "" : " — untick Active instead";
      throw badRequest("IN_USE", `Cannot delete: still used by ${refs.join(", ")}${hint}`);
    }
    if (entity === "users") for (const s of await tx.sessions.list({ userId: id })) await tx.sessions.delete(s.id);
    if (entity === "devices") {
      // Unused codes go back; they are never issued again (codes are unique forever).
      for (const p of await tx.batchCodePool.list({ deviceId: id, status: "RESERVED" })) await tx.batchCodePool.update(p.id, { status: "RETURNED" });
    }
    await repo.delete(id);
    return { ok: true, message: `Deleted ${current.name ?? current.code ?? id}` };
  });
}

// ---------------------------------------------------------------- approvals (HQ)

export const approvalSchema = z.object({
  userId: z.string().min(1),
  action: z.enum(["approve", "reject", "revoke", "resubmit"]),
  reason: z.string().trim().max(300).optional(),
});

/** Partner accounts with their approval state, for the HQ approvals screen. */
export async function listApprovals(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "approve");
  const [users, partners] = await Promise.all([store.users.list(), store.partners.list()]);
  return users
    .filter((u) => needsApproval(u.role))
    .map((u) => ({ ...userView(u, users), partnerName: partners.find((p) => p.id === u.partnerId)?.name ?? null }))
    .sort((a, b) => Number(a.status === "APPROVED") - Number(b.status === "APPROVED") || b.createdAt.localeCompare(a.createdAt));
}

/** HQ: approve / reject / revoke. Admin: resubmit a rejected account after fixing it. */
export async function approvalAction(userId: string | null, body: unknown) {
  const { userId: targetId, action, reason } = approvalSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, action === "resubmit" ? "admin" : "approve");
    const target = await tx.users.get(targetId);
    if (!target) throw notFound(`User ${targetId}`);
    if (!needsApproval(target.role)) throw badRequest("NO_APPROVAL", `${target.name} is Velza staff and needs no approval`);
    const at = nowIso();
    const users = await tx.users.list();
    let patch: Partial<User>;
    switch (action) {
      case "approve":
        if (!target.adminApprovedAt) throw badRequest("PENDING_ADMIN", `${target.name} must be approved by Velza Admin first`);
        patch = { hqApprovedBy: actor.user.id, hqApprovedAt: at, rejectedBy: null, rejectedAt: null, rejectReason: null };
        break;
      case "reject":
      case "revoke":
        if (!reason) throw badRequest("REASON_REQUIRED", "Give a reason");
        patch = { hqApprovedBy: null, hqApprovedAt: null, rejectedBy: actor.user.id, rejectedAt: at, rejectReason: reason };
        break;
      case "resubmit":
        patch = { adminApprovedBy: actor.user.id, adminApprovedAt: at, rejectedBy: null, rejectedAt: null, rejectReason: null };
        break;
    }
    const updated = await tx.users.update(targetId, patch);
    if (action === "reject" || action === "revoke") for (const s of await tx.sessions.list({ userId: targetId })) await tx.sessions.delete(s.id);
    return userView(updated, users);
  });
}

// ---------------------------------------------------------------- pools, settings

export async function listPools(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "admin");
  const [devices, pool, partners, settings] = await Promise.all([
    store.devices.list(),
    store.batchCodePool.list(),
    store.partners.list(),
    store.getSettings(),
  ]);
  return {
    settings: { poolIssueSize: settings.poolIssueSize, poolRefillBelow: settings.poolRefillBelow },
    devices: devices.map((d) => {
      const codes = pool.filter((p) => p.deviceId === d.id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
      return {
        device: d,
        manufacturer: partners.find((p) => p.id === d.manufacturerId)?.name ?? d.manufacturerId,
        reserved: codes.filter((c) => c.status === "RESERVED").length,
        used: codes.filter((c) => c.status === "USED").length,
        codes,
      };
    }),
  };
}

export async function issuePoolCodes(userId: string | null, deviceId: string, count?: number) {
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "admin");
    const device = await tx.devices.get(deviceId);
    if (!device) throw notFound(`Device ${deviceId}`);
    const settings = await tx.getSettings();
    const issued = await issueCodes(tx, device, count ?? settings.poolIssueSize, actor.user.id);
    return { issued, reserved: (await reservedCodes(tx, deviceId)).length };
  });
}

export const settingsSchema = z
  .object({
    notReceivedThresholdDays: z.number().min(0.01).max(365),
    demoMode: z.boolean(),
    demoThresholdMinutes: z.number().min(1).max(10_000),
    lotSticker: z.object({ widthMm: z.number().min(30).max(300), heightMm: z.number().min(15).max(300) }),
    packSticker: z.object({ widthMm: z.number().min(30).max(300), heightMm: z.number().min(15).max(300) }),
    publicBaseUrl: z.string().url(),
    poolIssueSize: z.number().int().min(1).max(100),
    poolRefillBelow: z.number().int().min(0).max(100),
    defaultCountry: z.string().regex(/^[0-9]{2}$/),
  })
  .partial();

export async function getSettings() {
  return getStore().getSettings();
}

export async function updateSettings(userId: string | null, body: unknown): Promise<Settings> {
  const patch = settingsSchema.parse(body);
  return getStore().transaction(async (tx) => {
    requireAction(await loadActor(tx, userId), "admin");
    if (patch.defaultCountry && !(await tx.countries.findOne({ code: patch.defaultCountry, active: true }))) {
      throw badRequest("BAD_COUNTRY", `Country ${patch.defaultCountry} is not in the active country list`);
    }
    return tx.updateSettings(patch);
  });
}

/**
 * Reference data for the signed-in user's screens. Velza staff see every partner and device;
 * a partner user sees only its own partner (and its own devices), never the rest of the network.
 */
export async function bootstrap(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  const [countries, flavours, allPartners, allDevices, settings] = await Promise.all([
    store.countries.list(),
    store.flavours.list(),
    store.partners.list(),
    store.devices.list(),
    store.getSettings(),
  ]);
  const staff = can(actor.role, "admin") || can(actor.role, "dashboard");
  const partners: Partner[] = staff ? allPartners : allPartners.filter((p) => p.id === actor.partner?.id);
  const devices = staff ? allDevices : allDevices.filter((d) => d.manufacturerId === actor.partner?.id);
  return { countries, flavours, partners, devices, settings };
}
