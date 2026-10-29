// Velza Admin: the partner registration form (partner + its sign-ins in one step), sign-ins and
// passwords, reference data, devices, pools, settings, deletes. The Admin has every right; people
// can only change their own password (services/auth.ts).

import { z } from "zod";
import { can } from "@/lib/core/permissions";
import { ASSIGNED_TO } from "@/lib/core/rules";
import {
  checkPassword,
  formatSequenceId,
  INDIAN_STATES,
  PARTNER_ID_PREFIX,
  PARTNER_LOGIN_ROLES,
  partnerLoginId,
  STAFF_ID_PREFIX,
} from "@/lib/core/ids";
import {
  PARTNER_TYPE_LABELS,
  PARTNER_TYPES,
  ROLE_LABELS,
  ROLE_PARTNER_TYPE,
  ROLES,
  type Partner,
  type PartnerType,
  type Role,
  type Settings,
  type User,
} from "@/lib/core/types";
import { hashPassword } from "@/lib/passwords";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, loadActor, notFound, nowIso, publicUser, requireAction, type Actor } from "./common";
import { autoRefill, issueCodes, reservedCodes } from "./pool";

const partnerFields = {
  type: z.enum(PARTNER_TYPES),
  name: z.string().trim().min(1, "Name is required").max(100),
  place: z.string().trim().min(1, "Place (locality) is required").max(80),
  address: z.string().trim().min(1, "Address is required").max(200),
  city: z.string().trim().min(1, "City is required").max(60),
  state: z.string().trim().max(60).optional(),
  pincode: z.string().trim().max(10).optional(),
  contactPerson: z.string().trim().min(1, "Contact person is required").max(100),
  phone: z.string().trim().min(1, "Phone is required").max(20),
  email: z.string().trim().max(120).optional(),
  parentId: z.string().nullable().optional(),
  active: z.boolean().optional(),
};

export const ENTITY_SCHEMAS = {
  partners: z.object(partnerFields),
  users: z.object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(ROLES),
    partnerId: z.string().nullable().optional(),
    active: z.boolean().optional(),
    password: z.string().max(200).optional(),
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

/** The registration form: the partner, plus the first password of its sign-in(s). */
export const registrationSchema = z.object({
  ...partnerFields,
  /** Sign-in password (at the plant: the Operator's). */
  password: z.string().max(200),
  /** Plant only: the QC sign-in's password. */
  qcPassword: z.string().max(200).optional(),
});

export type AdminEntity = keyof typeof ENTITY_SCHEMAS;
export const ADMIN_ENTITIES = Object.keys(ENTITY_SCHEMAS) as AdminEntity[];

export function isAdminEntity(s: string): s is AdminEntity {
  return (ADMIN_ENTITIES as string[]).includes(s);
}

const isIndianState = (s: string) => (INDIAN_STATES as readonly string[]).includes(s);
const digits = (phone: string | undefined) => (phone ?? "").replace(/[^0-9]/g, "");

/** Partner checks that need the other partners: address, contact, one SS per state, assignment. */
async function validatePartner(tx: StoreTx, data: Partial<Partner> & { type: PartnerType }, selfId?: string) {
  const type = data.type;
  const label = PARTNER_TYPE_LABELS[type];
  const state = data.state ?? "";
  if (type !== "MANUFACTURER" && !isIndianState(state)) throw badRequest("BAD_STATE", `Pick the state of this ${label}`);
  if (data.pincode && isIndianState(state) && !/^[1-9][0-9]{5}$/.test(data.pincode)) throw badRequest("BAD_PINCODE", "PIN code must be 6 digits");
  if (data.phone !== undefined && !/^\+?[0-9][0-9 ()-]{6,18}$/.test(data.phone)) throw badRequest("BAD_PHONE", "Phone: digits only, e.g. +91 98765 43210");
  if (data.email && !z.email().safeParse(data.email).success) throw badRequest("BAD_EMAIL", `${data.email} is not an email address`);

  const others = (await tx.partners.list()).filter((p) => p.id !== selfId);
  if (type === "SS") {
    const taken = others.find((p) => p.type === "SS" && p.state === state);
    if (taken) throw badRequest("STATE_TAKEN", `${state} already has a Super Stockist: ${taken.name} (${taken.id}). There is one Super Stockist per state.`);
  }
  if (data.phone) {
    const same = others.find((p) => digits(p.phone) === digits(data.phone!));
    if (same) throw badRequest("DUPLICATE", `Phone ${data.phone} is already used by ${same.name} (${same.id})`);
  }
  if (data.email) {
    const same = others.find((p) => p.email && p.email.toLowerCase() === data.email!.toLowerCase());
    if (same) throw badRequest("DUPLICATE", `Email ${data.email} is already used by ${same.name} (${same.id})`);
  }
  if (data.parentId) {
    const parentTypes = ASSIGNED_TO[type];
    if (!parentTypes) throw badRequest("BAD_PARENT", `A ${label} is not assigned to anyone`);
    const parent = await tx.partners.get(data.parentId);
    if (!parent || !parentTypes.includes(parent.type)) {
      throw badRequest("BAD_PARENT", `A ${label} must be assigned to a ${parentTypes.map((t) => PARTNER_TYPE_LABELS[t]).join(" or ")}`);
    }
  }
}

async function validateEntity(tx: StoreTx, entity: AdminEntity, data: Record<string, unknown>, selfId?: string) {
  if (entity === "users") {
    const role = data.role as Role;
    const needType = ROLE_PARTNER_TYPE[role];
    if (needType) {
      const partner = data.partnerId ? await tx.partners.get(String(data.partnerId)) : null;
      if (!partner || partner.type !== needType) {
        throw badRequest("BAD_PARTNER", `A ${ROLE_LABELS[role]} sign-in must belong to a ${PARTNER_TYPE_LABELS[needType]}`);
      }
    } else if (data.partnerId) {
      throw badRequest("BAD_PARTNER", `A ${ROLE_LABELS[role]} sign-in is Velza staff and has no partner`);
    }
  }
  if (entity === "devices") {
    const m = await tx.partners.get(String(data.manufacturerId));
    if (!m || m.type !== "MANUFACTURER") throw badRequest("BAD_PARTNER", "Devices belong to a manufacturer");
  }
  if (entity === "countries" || entity === "flavours") {
    const rows = await tx[entity].list({ code: data.code as string });
    if (rows.some((r) => r.id !== selfId)) throw badRequest("DUPLICATE", `Code ${data.code} already exists`);
  }
  if (entity === "partners") await validatePartner(tx, data as Partial<Partner> & { type: PartnerType }, selfId);
}

/** Never let the Admin lock everyone out. */
async function guardAdmins(tx: StoreTx, actor: Actor, target: User, next: Partial<User> | null) {
  const stillActive = next !== null && (next.active ?? target.active);
  if (target.id === actor.user.id && !stillActive) throw badRequest("SELF", "You cannot disable or delete your own sign-in");
  if (target.role === "ADMIN" && !stillActive) {
    const admins = (await tx.users.list({ role: "ADMIN", active: true })).filter((u) => u.id !== target.id);
    if (!admins.length) throw badRequest("LAST_ADMIN", "At least one active Velza Admin must remain");
  }
}

function requirePassword(pw: string | undefined, whose: string): string {
  const problem = pw === undefined || pw === "" ? "a password is required" : checkPassword(pw);
  if (problem) throw badRequest("WEAK_PASSWORD", `${whose}: ${problem}`);
  return pw!;
}

async function newUser(tx: StoreTx, id: string, name: string, role: Role, partnerId: string | null, passwordHash: string): Promise<User> {
  if (await tx.users.get(id)) throw badRequest("DUPLICATE", `Sign-in ${id} already exists`);
  const at = nowIso();
  return tx.users.create({ id, name, role, partnerId, active: true, passwordHash, passwordChangedAt: at, createdAt: at, lastLoginAt: null });
}

export async function listEntity(userId: string | null, entity: AdminEntity) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "admin");
  return entity === "users" ? (await store.users.list()).map(publicUser) : store[entity].list();
}

/**
 * The registration form: creates the partner with the next ID of its role (DB0001, DB0002 …) and its
 * sign-in(s) — the partner ID itself, or MF0001-OP and MF0001-QC at the plant — with the given passwords.
 */
export async function registerPartner(userId: string | null, body: unknown) {
  const { password, qcPassword, ...data } = registrationSchema.parse(body);
  const roles = PARTNER_LOGIN_ROLES[data.type];
  const plain = roles.map((r) => requirePassword(r === "QC" ? qcPassword : password, `${ROLE_LABELS[r]} password`));
  const hashes = await Promise.all(plain.map(hashPassword));
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "admin");
    const fields = { state: "", pincode: "", email: "", parentId: null, active: true, ...data };
    await validatePartner(tx, fields);
    const prefix = PARTNER_ID_PREFIX[data.type];
    const id = formatSequenceId(prefix, await tx.nextSequence(prefix));
    const partner = await tx.partners.create({ ...fields, id, createdAt: nowIso(), createdBy: actor.user.id });
    const logins: User[] = [];
    for (const [i, role] of roles.entries()) logins.push(await newUser(tx, partnerLoginId(role, id), data.contactPerson, role, id, hashes[i]));
    return {
      partner,
      logins: logins.map(publicUser),
      message: `Registered ${partner.name} as ${id} — sign-in ${logins.map((u) => u.id).join(" and ")}`,
    };
  });
}

export async function createEntity(userId: string | null, entity: AdminEntity, body: unknown) {
  if (entity === "partners") return registerPartner(userId, body);
  if (entity === "users") return createLogin(userId, body);
  const data = ENTITY_SCHEMAS[entity].parse(body);
  return getStore().transaction(async (tx) => {
    requireAction(await loadActor(tx, userId), "admin");
    await validateEntity(tx, entity, data);
    const defaults = entity === "devices" ? { offline: false, lastSyncAt: null } : { active: true };
    const row = { ...defaults, ...data, id: crypto.randomUUID() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await (tx[entity] as any).create(row);
    if (entity === "devices") await autoRefill(tx, created.id);
    return created;
  });
}

/**
 * A sign-in on its own: Velza staff (AD0001, HQ0001 …), or a partner sign-in that was deleted
 * (its ID comes from the partner again). Partner sign-ins are normally made by the registration form.
 */
async function createLogin(userId: string | null, body: unknown) {
  const data = ENTITY_SCHEMAS.users.parse(body);
  const passwordHash = await hashPassword(requirePassword(data.password, "Password"));
  return getStore().transaction(async (tx) => {
    requireAction(await loadActor(tx, userId), "admin");
    const partnerId = ROLE_PARTNER_TYPE[data.role] ? (data.partnerId ?? null) : null;
    await validateEntity(tx, "users", { ...data, partnerId });
    const staffPrefix = STAFF_ID_PREFIX[data.role];
    const id = staffPrefix ? formatSequenceId(staffPrefix, await tx.nextSequence(staffPrefix)) : partnerLoginId(data.role, partnerId!);
    return publicUser(await newUser(tx, id, data.name, data.role, partnerId, passwordHash));
  });
}

export async function updateEntity(userId: string | null, entity: AdminEntity, id: string, body: unknown) {
  const patch: Record<string, unknown> = ENTITY_SCHEMAS[entity].partial().parse(body);
  const newHash = entity === "users" && patch.password !== undefined ? await hashPassword(requirePassword(String(patch.password), "New password")) : null;
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
    if (entity === "partners" && patch.type && patch.type !== current.type) {
      throw badRequest("TYPE_LOCKED", `${id} is a ${PARTNER_TYPE_LABELS[current.type as PartnerType]}; the tier is part of its ID — register a new partner instead`);
    }
    if (entity === "users") {
      const user = current as User;
      if ((patch.role && patch.role !== user.role) || (patch.partnerId !== undefined && patch.partnerId !== user.partnerId)) {
        throw badRequest("ROLE_LOCKED", `Sign-in ${id} is tied to its role and partner — create a new sign-in instead`);
      }
      delete patch.role;
      delete patch.partnerId;
      delete patch.password;
      await guardAdmins(tx, actor, user, patch as Partial<User>);
      if (newHash) {
        Object.assign(patch, { passwordHash: newHash, passwordChangedAt: nowIso() });
        // A new password signs the person out everywhere.
        for (const s of await tx.sessions.list({ userId: id })) await tx.sessions.delete(s.id);
      }
      return publicUser(await repo.update(id, patch));
    }
    await validateEntity(tx, entity, { ...current, ...patch }, id);
    const updated = await repo.update(id, patch);
    if (entity === "devices" && current.offline && patch.offline === false) await autoRefill(tx, id);
    return updated;
  });
}

// ---------------------------------------------------------------- delete

/** Rows referenced by history can't be deleted (the ledger is permanent) — deactivate them instead. */
async function referencesTo(tx: StoreTx, entity: AdminEntity, row: { id: string; code?: unknown }): Promise<string[]> {
  const id = String(row.id);
  const found: string[] = [];
  const add = (n: number, what: string) => n && found.push(`${n} ${what}`);
  if (entity === "partners") {
    // Each reference read by its own filter (indexed where it matters), never whole tables; a row
    // matching on two fields is counted once.
    const [devices, children, lots, packs, moves, scans] = await Promise.all([
      tx.devices.list({ manufacturerId: id }),
      tx.partners.list({ parentId: id }),
      Promise.all([tx.lots.list({ manufacturerId: id }), tx.lots.list({ locationId: id }), tx.lots.list({ inTransitToId: id })]),
      Promise.all([tx.packs.list({ locationId: id }), tx.packs.list({ inTransitToId: id })]),
      Promise.all([tx.movements.list({ fromId: id }), tx.movements.list({ toId: id })]),
      tx.scans.list({ partnerId: id }),
    ]);
    const distinct = (lists: { id: string }[][]) => new Set(lists.flat().map((r) => r.id)).size;
    add(devices.length, "device(s)");
    add(children.length, "assigned partner(s)");
    add(distinct(lots), "lot(s)");
    add(distinct(packs), "pack(s)");
    add(distinct(moves), "movement(s)");
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

async function deleteLogin(tx: StoreTx, id: string) {
  for (const s of await tx.sessions.list({ userId: id })) await tx.sessions.delete(s.id);
  await tx.users.delete(id);
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
    // A partner's own sign-ins go with it, unless one of them already has history.
    const logins = entity === "partners" ? await tx.users.list({ partnerId: id }) : [];
    for (const u of logins) {
      const used = await referencesTo(tx, "users", u);
      if (used.length) refs.push(`sign-in ${u.id} (${used.join(", ")})`);
    }
    if (refs.length) {
      const hint = entity === "devices" ? "" : " — untick Active instead";
      throw badRequest("IN_USE", `Cannot delete: still used by ${refs.join(", ")}${hint}`);
    }
    if (entity === "devices") {
      // Unused codes go back; they are never issued again (codes are unique forever).
      for (const p of await tx.batchCodePool.list({ deviceId: id, status: "RESERVED" })) await tx.batchCodePool.update(p.id, { status: "RETURNED" });
    }
    for (const u of logins) await deleteLogin(tx, u.id);
    if (entity === "users") await deleteLogin(tx, id);
    else await repo.delete(id);
    const named = entity === "partners" || entity === "users" ? `${current.name} (${id})` : (current.name ?? current.code ?? id);
    const withLogins = logins.length ? ` and sign-in ${logins.map((u) => u.id).join(", ")}` : "";
    const never = entity === "partners" || entity === "users" ? ". Its ID is never reused." : "";
    return { ok: true, message: `Deleted ${named}${withLogins}${never}` };
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

/** Reference data for the signed-in user's screens: Velza staff see every partner and device, a partner only its own. */
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
