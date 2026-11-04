// DEF-002 regression: the trace lookup, dashboard, alerts, My partners, My stock and the other screens read
// only the rows they need (filtered in the store, not whole tables in memory) and still answer exactly as
// the whole-table versions did. Each answer is compared with that whole-table computation, done here
// from a full snapshot, on the JSON store and on PostgreSQL.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAlerts, type InTransitUnit } from "@/lib/core/alerts";
import { ITEM_STATUSES, type Lot, type Pack, type Role } from "@/lib/core/types";
import { getStore, type DbSnapshot, type StoreTx } from "@/lib/store";
import { deleteEntity } from "@/lib/services/admin";
import { damagedCounts, damagedUnits, listDamaged, reportDamaged } from "@/lib/services/damage";
import { dispatch, myPartners, openLot, receive } from "@/lib/services/movement";
import { setDeviceOffline } from "@/lib/services/operator";
import { codesForOrder, createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { alerts, batchReport, dashboard, listBatches, lookup, myStock, recall, recallReport, stockCounts } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
let lots: string[] = [];
let unsynced = "";
let orderId = "";

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
const partner = async (prefix: string) => (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;

async function printAndVerify(cases: number) {
  const created = await createPrintOrder(ids.operator, { batches: [{ flavour: "OR", mfgDate: "2026-10-26", expiryDate: "2027-07-26", cases, trays: 0 }] });
  if (created.preview) throw new Error("expected order");
  await markPrinted(ids.operator, created.printOrder.id);
  for (const lotCode of created.printOrder.lotCodes) {
    const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
    await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
  }
  return created.printOrder;
}

async function send(from: string, to: string, codes: string[], receiver?: string) {
  await dispatch(ids[from], { action: "confirm", toPartnerId: ids[to], invoice: `INV-${from}-${to}`, codes });
  if (receiver) for (const code of codes) await receive(ids[receiver], { code });
}

// ---------------------------------------------------------------- read recorder

const LARGE = ["lots", "packs", "movements", "scans", "reprints"] as const;
type Large = (typeof LARGE)[number];
interface Read {
  table: Large;
  where: Record<string, unknown> | undefined;
}

/** Every list() on the large tables while `fn` runs, at the top level and inside transactions. */
async function readsOf<R>(fn: () => Promise<R>): Promise<{ result: R; reads: Read[] }> {
  const s = store() as unknown as Record<string, unknown> & { transaction?: (f: (tx: StoreTx) => Promise<unknown>) => Promise<unknown> };
  const reads: Read[] = [];
  const watched = <T extends { list: (w?: Record<string, unknown>) => Promise<unknown> }>(repo: T, table: Large): T => ({
    ...repo,
    list: (where?: Record<string, unknown>) => (reads.push({ table, where }), repo.list(where)),
  });
  const saved = new Map<string, unknown>(LARGE.map((t) => [t, s[t]]));
  const hadOwnTransaction = Object.prototype.hasOwnProperty.call(s, "transaction");
  const transaction = s.transaction!;
  for (const t of LARGE) s[t] = watched(s[t] as never, t);
  s.transaction = (f) =>
    transaction.call(s, (tx: StoreTx) =>
      f(new Proxy(tx, { get: (target, key) => ((LARGE as readonly string[]).includes(key as string) ? watched(Reflect.get(target, key) as never, key as Large) : Reflect.get(target, key)) })),
    );
  try {
    return { result: await fn(), reads };
  } finally {
    for (const [t, repo] of saved) s[t] = repo;
    if (hadOwnTransaction) s.transaction = transaction;
    else delete s.transaction;
  }
}

/** Reads with no filter at all: the whole table. */
const whole = (reads: Read[], tables: readonly Large[] = LARGE) =>
  reads.filter((r) => tables.includes(r.table) && !Object.values(r.where ?? {}).some((v) => v !== undefined)).map((r) => r.table);

// ---------------------------------------------------------------- the whole-table computations (as before DEF-002)

async function reference() {
  const snap: DbSnapshot = await store().snapshot();
  const visibleLots = snap.lots.filter((l) => l.synced);
  const lotByCode = new Map(visibleLots.map((l) => [l.lotCode, l]));
  const visiblePacks = snap.packs.filter((p) => lotByCode.has(p.lotCode));
  const units: InTransitUnit[] = [
    ...visibleLots.filter((l) => l.status === "IN_TRANSIT" && l.dispatchedAt).map((l) => ({ kind: "LOT" as const, code: l.lotCode, fromId: l.locationId, toId: l.inTransitToId!, dispatchedAt: l.dispatchedAt! })),
    ...visiblePacks
      .filter((p) => p.status === "IN_TRANSIT" && p.dispatchedAt && lotByCode.get(p.lotCode)?.status === "OPENED")
      .map((p) => ({ kind: "PACK" as const, code: p.packCode, fromId: p.locationId, toId: p.inTransitToId!, dispatchedAt: p.dispatchedAt! })),
  ];
  const damageMoves = snap.movements.filter((m) => m.type === "DAMAGED");
  const settings = snap.settings[0] ?? (await store().getSettings());
  const alertList = computeAlerts({ scans: snap.scans, inTransit: units, damageReports: damageMoves.filter((m) => lotByCode.has(m.itemCode.slice(0, 15))), settings, now: new Date() });
  const damaged = damagedUnits(visibleLots, visiblePacks, damageMoves);
  const countBy = (rows: { status: string }[]) => Object.fromEntries(ITEM_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, c]) => c));
  return { snap, visibleLots, visiblePacks, lotByCode, units, alertList, damaged, countBy };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-scale-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  for (const [k, role, tag] of [
    ["admin", "ADMIN"],
    ["operator", "OPERATOR"],
    ["qc", "QC"],
    ["ss1", "SS", "SS-1"],
    ["ss2", "SS", "SS-2"],
    ["db1", "DB", "DB-1"],
    ["rt1", "RETAILER", "Retailer-1"],
    ["rt4", "RETAILER", "Retailer-4"],
    ["hq", "TRACE_OWNER"],
  ] as [string, Role, string?][]) {
    ids[k] = await user(role, tag);
  }
  for (const [k, prefix] of [["SS1", "SS-1"], ["SS2", "SS-2"], ["DB1", "DB-1"], ["DB2", "DB-2"], ["RT1", "Retailer-1"], ["RT2", "Retailer-2"], ["RT4", "Retailer-4"]]) {
    ids[k] = await partner(prefix);
  }
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("an empty network (no codes yet)", () => {
  it("dashboard, alerts, My partners and My stock answer with zeros and empty lists", async () => {
    expect(await dashboard(ids.hq)).toEqual({
      lotCounts: {},
      packCounts: {},
      totals: { lots: 0, packs: 0, batches: 0, unsyncedLots: 0 },
      stock: [],
      inTransit: [],
      alertCounts: {},
      recentAlerts: [],
      threshold: expect.objectContaining({ ms: expect.any(Number), label: expect.any(String) }),
    });
    expect(await alerts(ids.hq)).toEqual([]);
    const mine = await myPartners(ids.ss1);
    expect(mine.partners.map((p) => [p.id, p.lotsInStock, p.loosePacksInStock, p.onTheWayFromMe])).toEqual([
      [ids.DB1, 0, 0, 0],
      [ids.RT4, 0, 0, 0],
    ]);
    expect(await myStock(ids.rt1)).toMatchObject({ counts: { cases: 0, trays: 0, loosePacks: 0 }, inStock: [], outgoing: [], incoming: [] });
    expect(await listBatches(ids.hq)).toEqual([]);
  });
});

describe("a network with stock at every tier", () => {
  beforeAll(async () => {
    const order = await printAndVerify(6);
    lots = order.lotCodes;
    orderId = order.id;
    await send("operator", "SS1", [lots[0], lots[1], lots[2], lots[3]]);
    for (const code of [lots[0], lots[1], lots[2]]) await receive(ids.ss1, { code }); // lots[3] stays in transit
    await send("ss1", "DB1", [lots[1]], "db1");
    await send("db1", "RT1", [lots[1]], "rt1");
    await openLot(ids.rt1, { lotCode: lots[1] });
    await reportDamaged(ids.rt1, { code: `${lots[1]}63`, reason: "Leaking" });
    await send("ss1", "RT4", [lots[2]]); // in transit to a retailer the SS supplies directly
    await reportDamaged(ids.ss1, { code: lots[0], reason: "Crushed" });
    // Failed scans that raise alerts: a code for someone else, and a code never generated.
    await receive(ids.rt1, { code: lots[2] });
    await receive(ids.rt1, { code: "91ZZZZZZOR00001" });
    // lots[3] has been on the road long enough to be NOT_RECEIVED.
    await store().lots.update(lots[3], { dispatchedAt: "2026-01-01T00:00:00.000Z" });

    // A case made while the plant's device is offline: not synced, so nobody outside the plant may see it,
    // not even the damage the plant reports on it.
    const device = (await store().devices.list())[0];
    await setDeviceOffline(ids.operator, device.id, { offline: true });
    unsynced = (await printAndVerify(1)).lotCodes[0];
    expect((await store().lots.findOne({ lotCode: unsynced }))?.synced).toBe(false);
    expect(await reportDamaged(ids.operator, { code: `${unsynced}`, reason: "Dropped at the plant" })).toMatchObject({ ok: true });
  });

  describe("exact code lookup (HQ trace)", () => {
    it("returns the case with its own history only, in time order, with names, and no whole-table read", async () => {
      const ref = await reference();
      const { result: t, reads } = await readsOf(() => lookup(ids.hq, lots[1]));
      if (!t.found) throw new Error("not found");
      expect(whole(reads)).toEqual([]);
      expect(t).toMatchObject({ code: lots[1], kind: "LOT", status: "OPENED", location: expect.stringMatching(/^Retailer-1/), locationTier: "RETAILER" });
      const expected = ref.snap.movements.filter((m) => m.itemCode === lots[1] || (m.itemKind === "BATCH" && m.itemCode === lots[1].slice(2, 8))).sort((a, b) => a.at.localeCompare(b.at));
      expect(t.timeline.map((e) => [e.event, e.itemCode, e.at])).toEqual(expected.map((m) => [m.type, m.itemCode, m.at]));
      expect(t.timeline.map((e) => e.event)).toEqual(expect.arrayContaining(["DISPATCHED", "RECEIVED", "OPENED"]));
      expect(t.timeline.find((e) => e.event === "DISPATCHED" && e.to?.startsWith("DB-1"))).toMatchObject({ from: expect.stringMatching(/^SS-1/), user: expect.any(String) });
      expect(t.children.map((c) => c.code)).toEqual(ref.snap.packs.filter((p) => p.lotCode === lots[1]).sort((a, b) => a.seq - b.seq).map((p) => p.packCode));
      expect(t.children.find((c) => c.code === `${lots[1]}63`)).toMatchObject({ status: "DAMAGED", location: expect.stringMatching(/^Retailer-1/) });
    });

    it("a pack: the lot's and the pack's history, and its parent", async () => {
      const ref = await reference();
      const pack = `${lots[1]}63`;
      const { result: t, reads } = await readsOf(() => lookup(ids.hq, pack));
      if (!t.found) throw new Error("not found");
      expect(whole(reads)).toEqual([]);
      expect(t).toMatchObject({ kind: "PACK", status: "DAMAGED", parent: { code: lots[1], status: "OPENED" }, children: [] });
      const expected = ref.snap.movements.filter((m) => m.itemCode === lots[1] || m.itemCode === pack).sort((a, b) => a.at.localeCompare(b.at));
      expect(t.timeline.map((e) => [e.event, e.itemCode])).toEqual(expected.map((m) => [m.type, m.itemCode]));
      expect(t.timeline.at(-1)).toMatchObject({ event: "DAMAGED", itemCode: pack, note: "Leaking" });
    });

    it("the answer does not change when unrelated history is added", async () => {
      const before = await lookup(ids.hq, lots[1]);
      await send("operator", "SS1", [lots[4]], "ss1");
      await store().appendMovement({ type: "REPRINTED", itemKind: "LOT", itemCode: lots[5], fromId: null, toId: null, fromStatus: null, toStatus: null, userId: ids.operator, deviceId: null, invoice: null, note: "unrelated" });
      expect(await lookup(ids.hq, lots[1])).toEqual(before);
    });

    it("unknown, malformed and empty codes are not found; a QR link resolves to its code; every lookup is audited", async () => {
      const audited = async () => (await store().scans.list({ context: "LOOKUP" })).length;
      const n = await audited();
      expect(await lookup(ids.hq, "91ZZZZZZOR00001")).toMatchObject({ found: false, result: "UNKNOWN_CODE", message: expect.stringMatching(/never generated/) });
      expect(await lookup(ids.hq, "not-a-code")).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
      expect(await lookup(ids.hq, "")).toMatchObject({ found: false, result: "UNKNOWN_CODE" });
      expect(await lookup(ids.hq, `https://velza.example/c/${lots[1]}?src=qr`)).toMatchObject({ found: true, code: lots[1] });
      // The same code twice: the same answer, two audit rows.
      expect(await lookup(ids.hq, lots[2])).toEqual(await lookup(ids.hq, lots[2]));
      expect(await audited()).toBe(n + 6);
    });

    it("ten lookups of one code at once all answer the same, and each is audited", async () => {
      // On a PostgreSQL server these used to abort each other (serialization failures) when the read and the
      // audit scan shared one transaction; the embedded database runs transactions one at a time.
      const audited = async () => (await store().scans.list({ context: "LOOKUP", code: lots[2] })).length;
      const n = await audited();
      const answers = await Promise.all(Array.from({ length: 10 }, () => lookup(ids.hq, lots[2])));
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(answers[0]).toMatchObject({ found: true, code: lots[2] });
      expect(await audited()).toBe(n + 10);
    });

    it("keeps its access rules: HQ only, and unsynced codes stay invisible", async () => {
      await expect(lookup(ids.rt1, lots[1])).rejects.toMatchObject({ status: 403 });
      await expect(lookup(ids.ss1, lots[1])).rejects.toMatchObject({ status: 403 });
      await expect(lookup(null, lots[1])).rejects.toMatchObject({ status: 401 });
      expect(await lookup(ids.hq, unsynced)).toMatchObject({ found: false, result: "UNKNOWN_CODE", message: expect.stringMatching(/not synced/) });
    });
  });

  describe("HQ dashboard", () => {
    it("matches the whole-table computation field by field", async () => {
      const ref = await reference();
      const { result: d, reads } = await readsOf(() => dashboard(ids.hq));
      expect(Object.keys(d)).toEqual(["lotCounts", "packCounts", "totals", "stock", "inTransit", "alertCounts", "recentAlerts", "threshold"]);
      expect(d.lotCounts).toEqual(ref.countBy(ref.visibleLots));
      expect(d.packCounts).toEqual(ref.countBy(ref.visiblePacks));
      expect(d.totals).toEqual({ lots: ref.visibleLots.length, packs: ref.visiblePacks.length, batches: ref.snap.batches.filter((b) => b.synced).length, unsyncedLots: 1 });
      const stock = ref.snap.partners
        .map((p) => ({ partnerId: p.id, ...stockCounts(p.id, ref.visibleLots, ref.visiblePacks, ref.lotByCode), damaged: damagedCounts(ref.damaged.filter((u) => u.partnerId === p.id)) }))
        .filter((s) => s.cases || s.trays || s.loosePacks || s.damaged.cases || s.damaged.trays || s.damaged.packs);
      expect(d.stock.map(({ partnerId, cases, trays, openedCases, openedTrays, loosePacks, damaged }) => ({ partnerId, cases, trays, openedCases, openedTrays, loosePacks, damaged }))).toEqual(stock);
      expect(d.stock.find((s) => s.partnerId === ids.RT1)).toMatchObject({ cases: 1, openedCases: 1, loosePacks: 3, damaged: { packs: 1 } });
      expect(d.inTransit.map((u) => u.code)).toEqual([...ref.units].sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt)).map((u) => u.code));
      expect(d.alertCounts).toEqual(ref.alertList.reduce<Record<string, number>>((acc, a) => ((acc[a.type] = (acc[a.type] ?? 0) + 1), acc), {}));
      expect(d.recentAlerts.map((a) => a.id)).toEqual(ref.alertList.slice(0, 10).map((a) => a.id));
      // Stock needs every synced lot and pack; history and the scan audit are read by filter only.
      expect(whole(reads, ["movements", "scans", "reprints"])).toEqual([]);
      expect(reads.filter((r) => r.table === "scans").map((r) => r.where)).toEqual([{ ok: false }]);
    });

    it("is for HQ only", async () => {
      for (const who of ["ss1", "rt1", "operator", "admin"]) await expect(dashboard(ids[who])).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("HQ alerts", () => {
    it("match the whole-table computation, read by filter only, and never show unsynced codes", async () => {
      const ref = await reference();
      const { result: list, reads } = await readsOf(() => alerts(ids.hq));
      expect(whole(reads)).toEqual([]);
      expect(list.map((a) => [a.id, a.type, a.code])).toEqual(ref.alertList.map((a) => [a.id, a.type, a.code]));
      expect(new Set(list.map((a) => a.type))).toEqual(new Set(["NOT_RECEIVED", "WRONG_RECEIVER", "UNKNOWN_CODE", "DAMAGED"]));
      expect(list.find((a) => a.type === "NOT_RECEIVED")).toMatchObject({ code: lots[3], partner: expect.stringMatching(/^SS-1/) });
      expect(list.find((a) => a.type === "WRONG_RECEIVER")).toMatchObject({ code: lots[2], partner: expect.stringMatching(/^Retailer-1/), user: expect.any(String) });
      // The plant's damage report on its unsynced case is not shown; the only alert naming that code is HQ's
      // own failed lookup of it (a failed scan, as before).
      expect(list.filter((a) => a.code.startsWith(unsynced)).map((a) => [a.type, a.user])).toEqual([["UNKNOWN_CODE", "Velza HQ"]]);
      expect((await store().movements.list({ type: "DAMAGED", itemCode: unsynced })).length).toBe(1); // it was reported
    });

    it("are for HQ only", async () => {
      await expect(alerts(ids.ss1)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("My partners", () => {
    /** As computed before DEF-002, from every lot and pack. */
    async function expected(me: string) {
      const ref = await reference();
      const all = { lots: ref.snap.lots, packs: ref.snap.packs };
      const lotByCode = new Map(all.lots.map((l) => [l.lotCode, l]));
      const opened = new Set(all.lots.filter((l) => l.status === "OPENED").map((l) => l.lotCode));
      const loose = all.packs.filter((p) => opened.has(p.lotCode));
      return ref.snap.partners
        .filter((p) => p.parentId === me)
        .map((c) => {
          const s = stockCounts(c.id, all.lots, all.packs, lotByCode);
          const onTheWay =
            all.lots.filter((l) => l.status === "IN_TRANSIT" && l.locationId === me && l.inTransitToId === c.id).length +
            loose.filter((p) => p.status === "IN_TRANSIT" && p.locationId === me && p.inTransitToId === c.id).length;
          return [c.id, s.cases + s.trays, s.loosePacks, onTheWay];
        });
    }

    it("a Super Stockist: its distributors and direct retailers, counted as before, read by location only", async () => {
      const { result, reads } = await readsOf(() => myPartners(ids.ss1));
      expect(whole(reads)).toEqual([]);
      expect(result.partners.map((p) => [p.id, p.lotsInStock, p.loosePacksInStock, p.onTheWayFromMe])).toEqual(await expected(ids.SS1));
      expect(result.partners.map((p) => [p.id, p.onTheWayFromMe])).toEqual([
        [ids.DB1, 0],
        [ids.RT4, 1],
      ]);
    });

    it("a Distributor: its retailers, the loose packs at one of them, and nobody else's partners", async () => {
      const { result } = await readsOf(() => myPartners(ids.db1));
      expect(result.partners.map((p) => [p.id, p.lotsInStock, p.loosePacksInStock, p.onTheWayFromMe])).toEqual(await expected(ids.DB1));
      expect(result.partners.find((p) => p.id === ids.RT1)).toMatchObject({ lotsInStock: 1, loosePacksInStock: 3 });
      expect(result.partners.map((p) => p.id)).not.toContain(ids.RT4);
      expect((await myPartners(ids.ss2)).partners.map((p) => [p.id, p.lotsInStock])).toEqual([[ids.DB2, 0]]);
    });

    it("is for Super Stockists and Distributors only", async () => {
      for (const who of ["rt1", "hq", "operator"]) await expect(myPartners(ids[who])).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("My stock", () => {
    /** Codes in stock, outgoing and incoming as computed before DEF-002, from every lot and pack. */
    async function expected(partnerId: string) {
      const ref = await reference();
      const lotsV = ref.snap.lots.filter((l) => l.synced || l.manufacturerId === partnerId);
      const byCode = new Map(lotsV.map((l) => [l.lotCode, l]));
      const packs = ref.snap.packs.filter((p) => byCode.get(p.lotCode)?.status === "OPENED");
      const whole = new Set(ref.snap.movements.filter((m) => m.type === "DAMAGED" && m.itemKind === "LOT" && m.fromId === partnerId).map((m) => m.itemCode));
      const lc = (ls: Lot[]) => ls.map((l) => l.lotCode);
      const pc = (ps: Pack[]) => ps.map((p) => p.packCode);
      return {
        counts: stockCounts(partnerId, lotsV, packs, byCode),
        inStock: [
          ...lc(lotsV.filter((l) => l.locationId === partnerId && l.status !== "IN_TRANSIT" && l.status !== "DAMAGED" && !whole.has(l.lotCode))),
          ...pc(packs.filter((p) => p.locationId === partnerId && p.status !== "IN_TRANSIT" && p.status !== "DAMAGED")),
        ],
        outgoing: [...lc(lotsV.filter((l) => l.locationId === partnerId && l.status === "IN_TRANSIT")), ...pc(packs.filter((p) => p.locationId === partnerId && p.status === "IN_TRANSIT"))],
        incoming: [...lc(lotsV.filter((l) => l.inTransitToId === partnerId && l.status === "IN_TRANSIT")), ...pc(packs.filter((p) => p.inTransitToId === partnerId && p.status === "IN_TRANSIT"))],
      };
    }
    const codes = (s: Awaited<ReturnType<typeof myStock>>) => ({ counts: s.counts, inStock: s.inStock.map((x) => x.code), outgoing: s.outgoing.map((x) => x.code), incoming: s.incoming.map((x) => x.code) });

    it("each partner sees what is here, leaving and arriving — as before, read by location only", async () => {
      for (const [who, pid] of [["rt1", "RT1"], ["rt4", "RT4"], ["ss1", "SS1"], ["db1", "DB1"], ["operator", null]] as const) {
        const partnerId = pid ? ids[pid] : (await store().users.get(ids.operator))!.partnerId!;
        const { result, reads } = await readsOf(() => myStock(ids[who]));
        expect(whole(reads), who).toEqual([]);
        expect(codes(result), who).toEqual(await expected(partnerId));
      }
      const rt1 = await myStock(ids.rt1);
      expect(rt1.inStock.filter((s) => s.kind === "PACK")).toHaveLength(3); // a case holds 4 packs; the damaged one has left stock
      expect((await myStock(ids.rt4)).incoming.map((s) => s.code)).toEqual([lots[2]]);
    });

    it("the plant sees its unsynced case; nobody else does", async () => {
      expect((await myStock(ids.operator)).inStock.map((s) => s.code)).not.toContain(unsynced); // reported damaged
      expect((await listDamaged(ids.operator)).items.map((i) => i.code)).toEqual([unsynced]);
      for (const who of ["ss1", "db1", "rt1", "rt4"]) expect(JSON.stringify(await myStock(ids[who]))).not.toContain(unsynced);
    });

    it("is not for HQ", async () => {
      await expect(myStock(ids.hq)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("other screens with the same pattern", () => {
    it("Damaged section: as computed from every lot and pack, read by status only", async () => {
      const ref = await reference();
      const all = damagedUnits(ref.snap.lots, ref.snap.packs, ref.snap.movements.filter((m) => m.type === "DAMAGED"));
      for (const [who, pid] of [["ss1", "SS1"], ["rt1", "RT1"], ["db1", "DB1"]] as const) {
        const { result, reads } = await readsOf(() => listDamaged(ids[who]));
        expect(whole(reads, ["lots", "packs", "scans"]), who).toEqual([]);
        const mine = all.filter((u) => u.partnerId === ids[pid]);
        expect(result.counts, who).toEqual(damagedCounts(mine));
        expect(result.items.map((i) => i.code).sort(), who).toEqual(mine.map((u) => u.code).sort());
      }
    });

    it("batch list, batch report, recall report and a print order's codes: no whole lot, pack or history read", async () => {
      const batchCode = lots[0].slice(2, 8);
      const listed = await readsOf(() => listBatches(ids.hq));
      expect(whole(listed.reads, ["lots", "packs", "movements", "scans"])).toEqual([]);
      const ref = await reference();
      expect(listed.result.find((b) => b.code === batchCode)).toMatchObject({
        lots: ref.snap.lots.filter((l) => l.batchCode === batchCode).length,
        statusCounts: ref.snap.lots.filter((l) => l.batchCode === batchCode).reduce<Record<string, number>>((acc, l) => ((acc[l.status] = (acc[l.status] ?? 0) + 1), acc), {}),
      });
      expect(listed.result.map((b) => b.code)).not.toContain(unsynced.slice(2, 8)); // HQ sees synced batches only

      const report = await readsOf(() => batchReport(ids.hq, batchCode));
      expect(whole(report.reads, ["lots", "packs", "movements", "scans"])).toEqual([]);
      expect(report.result.summary).toMatchObject({ lots: 6, printed: 6, packed: 6 });

      const order = await readsOf(() => codesForOrder(ids.operator, orderId));
      expect(whole(order.reads)).toEqual([]);
      expect(order.result.totals).toMatchObject({ stickers: 6 * 5, cases: 6, packs: 6 * 4 });
      expect(order.result.codes.filter((r) => r.codeType === "PACK" && r.lotCode === lots[0]).map((r) => r.packSequence)).toEqual([1, 2, 3, 4]);

      await recall(ids.hq, { batchCode, reason: "Scalability regression check" });
      const recalled = await readsOf(() => recallReport(ids.hq, batchCode));
      expect(whole(recalled.reads)).toEqual([]);
      const opened = recalled.result.items.find((i) => i.code === lots[1])!;
      expect(opened).toMatchObject({ statusBeforeRecall: "OPENED", status: "RECALLED" });
      expect(opened.packs.map((p) => p.code)).toEqual([1, 2, 3, 4].map((s) => `${lots[1]}6${s}`));
      expect(recalled.result.items.filter((i) => i.code !== lots[1]).every((i) => i.packs.length === 0)).toBe(true);
      // The recall is in every lot's trace, read by the batch code (not the whole ledger).
      const t = await lookup(ids.hq, lots[5]);
      if (!t.found) throw new Error("not found");
      expect(t.timeline.filter((e) => e.itemKind === "BATCH").map((e) => e.event)).toEqual(["RECALLED"]);
    });

    it("deleting a partner with history is refused, counting its references by filter", async () => {
      const { result, reads } = await readsOf(() => deleteEntity(ids.admin, "partners", ids.RT1).catch((e: Error) => e));
      expect(whole(reads)).toEqual([]);
      expect(result).toMatchObject({ status: 400, message: expect.stringMatching(/lot\(s\).*pack\(s\).*movement\(s\)/) });
    });
  });
});
