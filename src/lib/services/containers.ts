// Shipping containers from the plant to the Velza Warehouse. A container is one trip: the operator enters the
// container's own number, scans cases and trays into it (LOADING), and dispatches it to a warehouse with an
// invoice — every lot in it is dispatched at once (IN_TRANSIT). The warehouse receives everything still on the
// way in it by scanning the container number once on its Receive page (RECEIVED). Lots in a container move,
// and are traced, exactly like lots dispatched one by one; their movements say which container they came in.

import { z } from "zod";
import { AT_STATUS, checkDispatchHeader, isBlocked, STOPPED_STATUSES } from "@/lib/core/rules";
import { CONTAINER_CAPACITY, type Container, type Partner } from "@/lib/core/types";
import { parseCode } from "@/lib/core/codes";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, findItem, forbidden, loadActor, logScan, manufacturerDevice, notFound, nowIso, requireAction, requirePartner, setLotState, type Actor, type FoundItem } from "./common";
import { checkOne, dispatchItems, receiveItem } from "./movement";
import { RECEIVE_MODE_OFF_MESSAGE, receiveModeAllowed } from "./customs";

/** The container's own number as printed on it: letters, digits and dashes, 3–20 characters (e.g. MSCU1234567). */
const CONTAINER_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,19}$/;
export const normalizeContainerCode = (raw: string) => raw.trim().toUpperCase().replace(/\s+/g, "");

export const createContainerSchema = z.object({ code: z.string().max(40) });
export const loadContainerSchema = z.object({ code: z.string().max(200) });
export const dispatchContainerSchema = z.object({ toPartnerId: z.string(), invoice: z.string().max(100) });
/** Customs clearance: the Bill of Entry number is optional. */
export const clearContainerSchema = z.object({ billOfEntry: z.string().trim().max(40).optional() });

const ACTIVE: Container["status"][] = ["LOADING", "IN_TRANSIT"];

function requirePlant(actor: Actor) {
  const me = requirePartner(actor);
  if (me.type !== "MANUFACTURER" || actor.user.role !== "OPERATOR") throw forbidden("Only the manufacturer's operator loads and dispatches containers");
  return me;
}

/** A container the viewer may see: the plant that loads it, the warehouse it goes to, or Velza HQ. */
function visibleTo(c: Container, actor: Actor) {
  if (actor.user.role === "TRACE_OWNER") return true;
  const me = actor.partner?.id;
  return !!me && (c.manufacturerId === me || c.toId === me);
}

async function ownLoading(tx: StoreTx, actor: Actor, id: string) {
  const me = requirePlant(actor);
  const c = await tx.containers.get(id);
  if (!c || c.manufacturerId !== me.id) throw notFound(`Container ${id}`);
  if (c.status !== "LOADING") throw badRequest("CONTAINER_NOT_LOADING", `Container ${c.code} was already dispatched — it can't be changed`);
  return { me, c };
}

async function summary(tx: StoreTx, list: Container[]) {
  const partners = new Map((await tx.partners.list()).map((p) => [p.id, p]));
  const name = (id: string | null) => (id ? (partners.get(id)?.name ?? id) : null);
  return list
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({ ...c, lots: c.lotCodes.length, manufacturer: name(c.manufacturerId), to: name(c.toId) }));
}

/** Operator: its plant's containers; warehouse: the containers coming or come to it; Velza HQ: all. */
export async function listContainers(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "container");
  const all = await store.containers.list();
  return { capacity: CONTAINER_CAPACITY, containers: await summary(store, all.filter((c) => visibleTo(c, actor))) };
}

/** One container with each of its cases and trays: type, status and where it is now. */
export async function getContainer(userId: string | null, id: string) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "container");
  const c = await store.containers.get(id);
  if (!c || !visibleTo(c, actor)) throw notFound(`Container ${id}`);
  const lots = await store.lots.list({ lotCode: c.lotCodes });
  const byCode = new Map(lots.map((l) => [l.lotCode, l]));
  const [row] = await summary(store, [c]);
  const lotRows = c.lotCodes.map((code) => {
    const l = byCode.get(code);
    return { code, lotType: l?.lotType ?? null, status: l?.status ?? null };
  });
  // "n of N received" at Customs: lots of the container that have left the plant's location — received at Customs
  // (a lot only changes location when it is received), whether still there or since sent on to an SS.
  const receivedCount = c.toId ? lots.filter((l) => l.locationId !== c.manufacturerId).length : 0;
  return {
    container: { ...row, receivedCount, total: c.lotCodes.length },
    capacity: CONTAINER_CAPACITY,
    cases: lotRows.filter((l) => l.lotType === "CASE").length,
    trays: lotRows.filter((l) => l.lotType === "TRAY").length,
    lots: lotRows,
  };
}

export async function createContainer(userId: string | null, body: unknown) {
  const code = normalizeContainerCode(createContainerSchema.parse(body).code);
  if (!CONTAINER_CODE_RE.test(code)) throw badRequest("BAD_CONTAINER_CODE", "Enter the container number as printed on it: letters, digits and dashes, 3–20 characters (e.g. MSCU1234567)");
  if (parseCode(code).ok) throw badRequest("BAD_CONTAINER_CODE", `${code} is a case/tray or pack code, not a container number`);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "container");
    const me = requirePlant(actor);
    const active = (await tx.containers.list({ code })).find((c) => ACTIVE.includes(c.status));
    if (active) {
      const where = active.status === "LOADING" ? "is still being loaded" : "is still on its way to the warehouse";
      throw badRequest("CONTAINER_IN_USE", `Container ${code} ${where} — finish that trip first`);
    }
    const c: Container = {
      id: crypto.randomUUID(),
      code,
      manufacturerId: me.id,
      status: "LOADING",
      lotCodes: [],
      toId: null,
      invoice: null,
      createdAt: nowIso(),
      createdBy: actor.user.id,
      dispatchedAt: null,
      dispatchedBy: null,
      receivedAt: null,
      receivedBy: null,
    };
    return { container: await tx.containers.create(c), message: `Container ${code} opened for loading` };
  });
}

/** Scan a case or tray into a loading container: packed (QC passed), synced, at the plant and in no other container. */
export async function loadContainer(userId: string | null, id: string, body: unknown) {
  const raw = loadContainerSchema.parse(body).code.trim();
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "container");
    const { me, c } = await ownLoading(tx, actor, id);
    const deviceId = (await manufacturerDevice(tx, me.id)).id;
    const reject = async (result: string, message: string) => {
      await logScan(tx, { context: "CONTAINER", code: raw, actor, ok: false, result, message, deviceId });
      return { ok: false as const, code: result, message };
    };
    const found = await findItem(tx, raw, me.id);
    if (!found.ok) return reject(found.code, found.message);
    const { item } = found;
    if (item.kind !== "LOT") return reject("INVALID_CODE", `${raw} is a pack — scan the case or tray sticker`);
    const lot = item.lot;
    if (isBlocked(lot.status)) return reject("BLOCKED_CODE", `${lot.lotCode} is ${lot.status} and must not move`);
    if (STOPPED_STATUSES.includes(lot.status)) return reject("WRONG_STATUS", `${lot.lotCode} is ${lot.status}`);
    if (!lot.synced) return reject("UNSYNCED", `${lot.lotCode} is not synced yet — sync the device first`);
    if (lot.locationId !== me.id || lot.status !== "PACKED") {
      const hint = lot.status === "PRINTED" || lot.status === "GENERATED" ? " — QC must verify it first" : "";
      return reject("WRONG_STATUS", `${lot.lotCode} is ${lot.status}, must be PACKED at the plant${hint}`);
    }
    if (c.lotCodes.includes(lot.lotCode)) return reject("DUPLICATE_SCAN", `${lot.lotCode} is already in container ${c.code}`);
    const other = (await tx.containers.list({ manufacturerId: me.id, status: "LOADING" })).find((x) => x.id !== c.id && x.lotCodes.includes(lot.lotCode));
    if (other) return reject("DUPLICATE_SCAN", `${lot.lotCode} is already in container ${other.code}`);
    if (c.lotCodes.length >= CONTAINER_CAPACITY) return reject("CONTAINER_FULL", `Container ${c.code} is full (${CONTAINER_CAPACITY} cases/trays)`);
    const updated = await tx.containers.update(c.id, { lotCodes: [...c.lotCodes, lot.lotCode] });
    const message = `${lot.lotCode} (${lot.lotType}) loaded into ${c.code} — ${updated.lotCodes.length} / ${CONTAINER_CAPACITY}`;
    await logScan(tx, { context: "CONTAINER", code: raw, actor, ok: true, result: "OK", message, deviceId });
    return { ok: true as const, message, count: updated.lotCodes.length };
  });
}

/** Take a case or tray out of a container that is still loading. */
export async function unloadContainer(userId: string | null, id: string, body: unknown) {
  const code = loadContainerSchema.parse(body).code.trim();
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "container");
    const { c } = await ownLoading(tx, actor, id);
    if (!c.lotCodes.includes(code)) throw badRequest("NOT_IN_CONTAINER", `${code} is not in container ${c.code}`);
    const updated = await tx.containers.update(c.id, { lotCodes: c.lotCodes.filter((x) => x !== code) });
    return { ok: true, message: `${code} taken out of ${c.code}`, count: updated.lotCodes.length };
  });
}

/** Cancel a container that is still loading (nothing has moved yet). */
export async function cancelContainer(userId: string | null, id: string) {
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "container");
    const { c } = await ownLoading(tx, actor, id);
    await tx.containers.delete(c.id);
    return { ok: true, message: `Container ${c.code} cancelled — its ${c.lotCodes.length} case(s)/tray(s) stay at the plant` };
  });
}

/** Dispatch the whole container to a Velza Warehouse: all its lots or none (each checked like a normal dispatch). */
export async function dispatchContainer(userId: string | null, id: string, body: unknown) {
  const req = dispatchContainerSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "container");
    requireAction(actor, "dispatch");
    const { me, c } = await ownLoading(tx, actor, id);
    if (!c.lotCodes.length) throw badRequest("CONTAINER_EMPTY", `Container ${c.code} is empty — scan cases and trays into it first`);
    const receiver = await tx.partners.get(req.toPartnerId);
    const header = checkDispatchHeader(me, receiver, req.invoice);
    if (!header.ok) throw badRequest(header.code, header.message);
    const checks = await Promise.all(c.lotCodes.map(async (code) => ({ code, ...(await checkOne(tx, actor, me, receiver, req.invoice, code)) })));
    const failed = checks.filter((x) => !x.result.ok);
    if (failed.length) {
      throw badRequest(
        "DISPATCH_REJECTED",
        `Nothing dispatched: ${failed.length} case(s)/tray(s) in container ${c.code} can't go — take them out or fix them first`,
        failed.map((f) => ({ code: f.code, reason: f.result.ok ? "" : f.result.message })),
      );
    }
    const at = nowIso();
    const invoice = req.invoice.trim();
    const deviceId = (await manufacturerDevice(tx, me.id)).id;
    await dispatchItems(tx, { actor, sender: me, receiver: receiver!, invoice, items: checks.map((x) => x.item as FoundItem), deviceId, note: `Container ${c.code}`, at });
    const updated = await tx.containers.update(c.id, { status: "IN_TRANSIT", toId: receiver!.id, invoice, dispatchedAt: at, dispatchedBy: actor.user.id });
    return {
      ok: true,
      container: updated,
      message: `Container ${c.code} dispatched to ${receiver!.name} on ${invoice}: ${c.lotCodes.length} case(s)/tray(s)`,
    };
  });
}

/**
 * Customs clearance by the Velza person at Customs. Every lot of the container held here (AT_CUSTOMS) — and its
 * packs — becomes cleared stock (AT_WAREHOUSE), ready to dispatch to a Super Stockist; lots still on the way are
 * cleared when they arrive. Allowed once the first of its lots has arrived (customs clears the whole container's
 * paperwork); lots damaged, recalled or otherwise not held here are left as they are.
 */
export async function clearContainer(userId: string | null, id: string, body: unknown) {
  const req = clearContainerSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "customsClear");
    const me = requirePartner(actor);
    const c = await tx.containers.get(id);
    if (!c || c.toId !== me.id) throw notFound(`Container ${id}`);
    if (c.status === "CLEARED") throw badRequest("ALREADY_CLEARED", `Container ${c.code} was already cleared`);
    if (c.status !== "RECEIVED") throw badRequest("CONTAINER_NOT_RECEIVED", `Container ${c.code} hasn't arrived yet — receive it first`);
    const at = nowIso();
    const billOfEntry = req.billOfEntry || null;
    const note = billOfEntry ? `Bill of Entry ${billOfEntry}` : "Customs cleared";
    let cleared = 0;
    for (const lot of await tx.lots.list({ lotCode: c.lotCodes })) {
      if (lot.status !== "AT_CUSTOMS" || lot.locationId !== me.id) continue;
      await setLotState(tx, lot, { status: "AT_WAREHOUSE" }, at);
      await tx.appendMovement({ type: "CUSTOMS_CLEARED", itemKind: "LOT", itemCode: lot.lotCode, fromId: me.id, toId: me.id, fromStatus: "AT_CUSTOMS", toStatus: "AT_WAREHOUSE", userId: actor.user.id, deviceId: null, invoice: c.invoice, note });
      cleared++;
    }
    const notHere = c.lotCodes.length - cleared;
    const container = await tx.containers.update(c.id, { status: "CLEARED", clearedAt: at, clearedBy: actor.user.id, billOfEntry });
    const rest = notHere ? ` (${notHere} not here or not held — still on the way ones are cleared when they arrive)` : "";
    return { ok: true as const, container, cleared, notHere, message: `Container ${c.code} cleared: ${cleared} case(s)/tray(s) ready to dispatch${rest}` };
  });
}

/**
 * Receive scan of a container number (called by the Receive page's scan when the code is not a case, tray or
 * pack code). Receives every lot of the container still on its way to this receiver — also after some of its lots
 * were received one by one. At Customs the lots are held (AT_CUSTOMS) unless the container was already cleared.
 * Returns null when no container has this number, so the scan is answered as an unknown code.
 */
export async function receiveContainer(tx: StoreTx, actor: Actor, receiver: Partner, raw: string) {
  const code = normalizeContainerCode(raw);
  if (!CONTAINER_CODE_RE.test(code)) return null;
  const withCode = await tx.containers.list({ code });
  const rank = (c: Container) => (c.status === "IN_TRANSIT" ? 1 : 0);
  const mine = withCode
    .filter((c) => c.toId === receiver.id && (c.status === "IN_TRANSIT" || c.status === "RECEIVED" || c.status === "CLEARED"))
    .sort((a, b) => rank(b) - rank(a) || (b.dispatchedAt ?? "").localeCompare(a.dispatchedAt ?? ""))[0];
  const fail = async (result: string, message: string) => {
    await logScan(tx, { context: "RECEIVE", code, actor, ok: false, result, message });
    return { ok: false, code: result, message };
  };
  if (!mine) {
    if (withCode.some((c) => c.status === "IN_TRANSIT")) return fail("WRONG_RECEIVER", `Container ${code} is not on its way to ${receiver.name}`);
    return null;
  }
  if (receiver.type === "WAREHOUSE" && !receiveModeAllowed(await tx.getSettings(), "CONTAINER")) return fail("RECEIVE_MODE_OFF", RECEIVE_MODE_OFF_MESSAGE.CONTAINER);
  const at = nowIso();
  let received = 0;
  let skipped = 0;
  for (const lotCode of mine.lotCodes) {
    const found = await findItem(tx, lotCode, receiver.id);
    // A lot received on its own earlier (or stopped on the way) is left as it is.
    if (!found.ok || found.item.movable.status !== "IN_TRANSIT" || found.item.movable.inTransitToId !== receiver.id) {
      skipped++;
      continue;
    }
    await receiveItem(tx, { actor, receiver, item: found.item, at, note: `Container ${code}`, container: mine });
    received++;
  }
  if (!received && mine.status !== "IN_TRANSIT") return fail("DUPLICATE_RECEIPT", `Container ${code} was already received at ${receiver.name}`);
  if (mine.status === "IN_TRANSIT") await tx.containers.update(mine.id, { status: "RECEIVED", receivedAt: at, receivedBy: actor.user.id });
  const status = receiver.type !== "WAREHOUSE" ? AT_STATUS[receiver.type] : mine.status === "CLEARED" ? ("AT_WAREHOUSE" as const) : ("AT_CUSTOMS" as const);
  const label = status === "AT_CUSTOMS" ? "At customs, awaiting clearance" : status === "AT_WAREHOUSE" ? "Cleared at customs" : status;
  const rest = skipped ? ` (${skipped} already received or no longer on the way)` : "";
  const message = `Container ${code} received: ${received} case(s)/tray(s) → ${label}${rest}`;
  await logScan(tx, { context: "RECEIVE", code, actor, ok: true, result: "OK", message });
  return { ok: true, message, status, container: { code, received, skipped } };
}
