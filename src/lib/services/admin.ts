// Velza Admin: reference data, partners, users, devices, pools, settings.

import { z } from "zod";
import { PARTNER_TYPES, ROLE_PARTNER_TYPE, ROLES, type Settings } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, loadActor, notFound, requireAction } from "./common";
import { autoRefill, issueCodes, reservedCodes } from "./pool";

export const ENTITY_SCHEMAS = {
  partners: z.object({
    type: z.enum(PARTNER_TYPES),
    name: z.string().trim().min(1).max(100),
    city: z.string().trim().min(1).max(60),
    active: z.boolean().optional(),
  }),
  users: z.object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(ROLES),
    partnerId: z.string().nullable().optional(),
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
      throw badRequest("BAD_PARTNER", `A ${role} user is Velza HQ staff and has no partner`);
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
  if (entity === "partners" && selfId) {
    const current = await tx.partners.get(selfId);
    if (current && current.type !== data.type) {
      const users = await tx.users.list({ partnerId: selfId });
      if (users.length) throw badRequest("IN_USE", "Cannot change the tier of a partner that has users");
    }
  }
}

export async function listEntity(userId: string | null, entity: AdminEntity) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "admin");
  return store[entity].list();
}

export async function createEntity(userId: string | null, entity: AdminEntity, body: unknown) {
  const data = ENTITY_SCHEMAS[entity].parse(body);
  return getStore().transaction(async (tx) => {
    requireAction(await loadActor(tx, userId), "admin");
    await validateEntity(tx, entity, { partnerId: null, ...data });
    const defaults = entity === "devices" ? { offline: false, lastSyncAt: null } : entity === "users" ? { active: true, partnerId: null } : { active: true };
    const row = { ...defaults, ...data, id: crypto.randomUUID() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await (tx[entity] as any).create(row);
    if (entity === "devices") await autoRefill(tx, created.id);
    return created;
  });
}

export async function updateEntity(userId: string | null, entity: AdminEntity, id: string, body: unknown) {
  const patch: Record<string, unknown> = ENTITY_SCHEMAS[entity].partial().parse(body);
  return getStore().transaction(async (tx) => {
    requireAction(await loadActor(tx, userId), "admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = tx[entity] as any;
    const current = await repo.get(id);
    if (!current) throw notFound(`${entity} ${id}`);
    if ((entity === "countries" || entity === "flavours") && patch.code && patch.code !== current.code) {
      throw badRequest("CODE_LOCKED", "Codes are used inside printed stickers and cannot be changed; add a new entry instead");
    }
    await validateEntity(tx, entity, { ...current, ...patch }, id);
    const updated = await repo.update(id, patch);
    if (entity === "devices" && current.offline && patch.offline === false) await autoRefill(tx, id);
    return updated;
  });
}

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

/** Reference data for the role switcher and forms (no user needed). */
export async function bootstrap() {
  const store = getStore();
  const [countries, flavours, partners, users, devices, settings] = await Promise.all([
    store.countries.list(),
    store.flavours.list(),
    store.partners.list(),
    store.users.list(),
    store.devices.list(),
    store.getSettings(),
  ]);
  return { countries, flavours, partners, users, devices, settings };
}
