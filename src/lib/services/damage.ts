// Damaged stock: any partner holding cases, trays or packs reports damage; the units stop moving,
// leave the partner's stock and are listed in its Damaged section. HQ sees each report as an alert.

import { z } from "zod";
import { AT_STATUS, canReportDamaged, type RuleResult } from "@/lib/core/rules";
import type { Lot, Movement, Pack, Partner } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { findItem, loadActor, logScan, manufacturerDevice, nowIso, requireAction, requirePartner, setLotState, type FoundItem } from "./common";

export const damageSchema = z.object({ code: z.string().max(200), reason: z.string().max(300) });

const inStockAt = (p: Pack, partner: Partner) => p.locationId === partner.id && p.status === AT_STATUS[partner.type];

export async function reportDamaged(userId: string | null, body: unknown) {
  const { code, reason } = damageSchema.parse(body);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "damage");
    const partner = requirePartner(actor);
    const deviceId = partner.type === "MANUFACTURER" ? (await manufacturerDevice(tx, partner.id)).id : null;
    const found = await findItem(tx, code, partner.id);
    // An opened case/tray is reported whole too: what is left of it here.
    const openedHere =
      found.ok && found.item.kind === "LOT" && found.item.lot.status === "OPENED"
        ? (await tx.packs.list({ lotCode: found.item.lot.lotCode })).filter((p) => inStockAt(p, partner))
        : [];
    const result: RuleResult = found.ok
      ? canReportDamaged({ item: found.item.movable, parentLotStatus: found.item.parentLotStatus, partner, reason, packsHere: openedHere.length })
      : found;
    if (!result.ok) {
      await logScan(tx, { context: "DAMAGE", code, actor, ok: false, result: result.code, message: result.message, deviceId });
      return { ok: false, code: result.code, message: result.message };
    }
    const item = (found as { item: FoundItem }).item;
    const at = nowIso();
    const note = reason.trim();
    const opened = item.kind === "LOT" && item.lot.status === "OPENED";
    // An opened lot stays OPENED (its packs elsewhere keep moving); only its packs here become DAMAGED.
    if (opened) for (const p of openedHere) await tx.packs.update(p.id, { status: "DAMAGED", updatedAt: at });
    else if (item.kind === "LOT") await setLotState(tx, item.lot, { status: "DAMAGED" }, at);
    else await tx.packs.update(item.pack!.id, { status: "DAMAGED", updatedAt: at });
    await tx.appendMovement({
      type: "DAMAGED",
      itemKind: item.kind,
      itemCode: item.movable.code,
      fromId: partner.id,
      toId: null,
      fromStatus: item.movable.status,
      toStatus: "DAMAGED",
      userId: actor.user.id,
      deviceId,
      invoice: null,
      note,
    });
    const unit = item.lot.lotType === "CASE" ? "Case" : "Tray";
    const what =
      item.kind === "PACK" ? `Pack ${code}` : opened ? `Opened ${unit.toLowerCase()} ${code} (${openedHere.length} packs left here)` : `${unit} ${code} and its packs`;
    const message = `${what} reported damaged — removed from stock, HQ informed`;
    await logScan(tx, { context: "DAMAGE", code, actor, ok: true, result: "OK", message, deviceId });
    return { ok: true, message };
  });
}

export interface DamagedUnit {
  partnerId: string;
  kind: "LOT" | "PACK";
  code: string;
  lot: Lot;
  opened: boolean; // a lot reported whole after it was opened
  packs: number;
  report: Movement | undefined;
}

type DamageReport = Pick<Movement, "itemKind" | "itemCode" | "fromId" | "at">;

/**
 * Every damaged unit and where it is: sealed lots reported whole, opened lots reported whole
 * (lot stays OPENED, its packs at the reporter are DAMAGED), and single packs of opened lots.
 */
export function damagedUnits<M extends DamageReport>(lots: Lot[], packs: Pack[], reports: M[]) {
  const lotByCode = new Map(lots.map((l) => [l.lotCode, l]));
  const latest = (code: string) => reports.filter((m) => m.itemCode === code).sort((a, b) => b.at.localeCompare(a.at))[0];
  const damagedPacks = packs.filter((p) => p.status === "DAMAGED");
  const units: (Omit<DamagedUnit, "report"> & { report: M | undefined })[] = [];
  for (const l of lots.filter((x) => x.status === "DAMAGED" && x.locationId)) {
    units.push({ partnerId: l.locationId!, kind: "LOT", code: l.lotCode, lot: l, opened: false, packs: damagedPacks.filter((p) => p.lotCode === l.lotCode).length, report: latest(l.lotCode) });
  }
  const wholeOpened = new Set<string>(); // `${partnerId}|${lotCode}`
  for (const m of reports.filter((x) => x.itemKind === "LOT" && x.fromId && lotByCode.get(x.itemCode)?.status === "OPENED")) {
    const key = `${m.fromId}|${m.itemCode}`;
    if (wholeOpened.has(key)) continue;
    wholeOpened.add(key);
    const lot = lotByCode.get(m.itemCode)!;
    units.push({ partnerId: m.fromId!, kind: "LOT", code: lot.lotCode, lot, opened: true, packs: damagedPacks.filter((p) => p.lotCode === lot.lotCode && p.locationId === m.fromId).length, report: latest(lot.lotCode) });
  }
  for (const p of damagedPacks) {
    const lot = lotByCode.get(p.lotCode);
    if (lot?.status !== "OPENED" || !p.locationId || wholeOpened.has(`${p.locationId}|${p.lotCode}`)) continue;
    units.push({ partnerId: p.locationId, kind: "PACK", code: p.packCode, lot, opened: false, packs: 1, report: latest(p.packCode) });
  }
  return units;
}

/** Cases, trays and single packs reported damaged, from a list of units. */
export function damagedCounts(units: Pick<DamagedUnit, "kind" | "lot">[]) {
  return {
    cases: units.filter((u) => u.kind === "LOT" && u.lot.lotType === "CASE").length,
    trays: units.filter((u) => u.kind === "LOT" && u.lot.lotType === "TRAY").length,
    packs: units.filter((u) => u.kind === "PACK").length,
  };
}

/** The Damaged section of the current user's location, with counts of cases, trays and single packs. */
export async function listDamaged(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "damage");
  const partner = requirePartner(actor);
  // damagedUnits only looks at damaged lots and packs and at the lots of damage reports and damaged packs.
  const [damagedLots, packs, moves, users, flavours] = await Promise.all([
    store.lots.list({ status: "DAMAGED" }),
    store.packs.list({ status: "DAMAGED" }),
    store.movements.list({ type: "DAMAGED" }),
    store.users.list(),
    store.flavours.list(),
  ]);
  const related = await store.lots.list({ lotCode: [...new Set([...moves.map((m) => m.itemCode.slice(0, 15)), ...packs.map((p) => p.lotCode)])] });
  const lots = [...new Map([...damagedLots, ...related].map((l) => [l.id, l])).values()];
  const units = damagedUnits(lots, packs, moves).filter((u) => u.partnerId === partner.id);
  const items = units.map((u) => ({
    code: u.code,
    kind: u.kind,
    lotType: u.lot.lotType,
    opened: u.opened,
    packs: u.packs,
    flavour: flavours.find((f) => f.code === u.lot.flavour)?.name ?? u.lot.flavour,
    batchCode: u.lot.batchCode,
    reason: u.report?.note ?? null,
    reportedAt: u.report?.at ?? null,
    reportedBy: users.find((x) => x.id === u.report?.userId)?.name ?? null,
  }));
  return { partner, counts: damagedCounts(units), items: items.sort((a, b) => (b.reportedAt ?? "").localeCompare(a.reportedAt ?? "")) };
}
