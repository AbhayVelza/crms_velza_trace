// Serial uniqueness and duplicate-print protection (audit of 4 Nov 2026, P0–P2). Runs on the JSON file
// store and on PostgreSQL (embedded), like every tests/unit file. The two-process PostgreSQL test needs a
// real server and runs from tests/qa/serialMultiProcess.ts.
//
// Lot numbers are hexadecimal: 100 lots are 00001…00064 and the next one, decimal 101, is 00065.

import { execFileSync } from "node:child_process";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatLotNumber } from "@/lib/core/codes";
import type { Role } from "@/lib/core/types";
import { closeStores, getStore, storeKind } from "@/lib/store";
import { dispatch, receive } from "@/lib/services/movement";
import { listReprints, reprint, voidLot } from "@/lib/services/operator";
import {
  continueBatch,
  createPrintOrder,
  markPrinted,
  reprintServedId,
  serveReprint,
  stickerByCodeRefused,
  stickersForOrder,
} from "@/lib/services/printOrders";
import { recall } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

const isJson = storeKind() === "json";
const store = () => getStore();
const key = () => crypto.randomUUID();
const ids: Record<string, string> = {};
let dir: string;

const body = (cases: number, trays = 0, flavour = "OR") => ({ batches: [{ flavour, mfgDate: "2026-11-01", expiryDate: "2027-11-01", cases, trays }] });
async function created<T extends { preview: boolean }>(p: Promise<T>) {
  const r = await p;
  if (r.preview) throw new Error("expected an order");
  return r as Exclude<T, { preview: true }>;
}
const nextLotOf = async (code: string) => (await store().batches.findOne({ code }))!.nextLot;
const lotsOf = async (printOrderId: string) => (await store().lots.list({ printOrderId })).sort((a, b) => a.lotNumber - b.lotNumber);

/** Whole-store duplicate check: zero duplicates, every code in exactly one order, every counter = max lot + 1. */
async function integrity() {
  const s = await store().snapshot();
  const codes = [...s.lots.map((l) => l.lotCode), ...s.packs.map((p) => p.packCode)];
  const owners = new Map<string, number>();
  for (const o of s.printOrders) for (const c of o.lotCodes) owners.set(c, (owners.get(c) ?? 0) + 1);
  const badCounters = s.batches.filter((b) => {
    const ns = s.lots.filter((l) => l.batchCode === b.code).map((l) => l.lotNumber);
    return ns.length > 0 && (b.nextLot !== Math.max(...ns) + 1 || new Set(ns).size !== ns.length);
  });
  return {
    duplicateSerials: codes.length - new Set(codes).size,
    codesInTwoOrders: [...owners.values()].filter((n) => n > 1).length,
    lotsOutsideTheirOrder: s.lots.filter((l) => !s.printOrders.find((o) => o.id === l.printOrderId)?.lotCodes.includes(l.lotCode)).length,
    badCounters: badCounters.map((b) => b.code),
  };
}

async function qcVerify(lotCode: string) {
  const lot = (await store().lots.findOne({ lotCode }))!;
  const packs = Array.from({ length: lot.lotType === "CASE" ? 4 : 6 }, (_, i) => `${lotCode}${lot.packSize}${i + 1}`);
  await verify(ids.qc, { action: "scanLot", code: lotCode });
  for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
  return verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-serial-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  if (!isJson) process.env.PGLITE_DIR = path.join(dir, "pg");
  await store().reset(buildSampleSeed());
  const [users, partners] = [await store().users.list(), await store().partners.list()];
  const user = (role: Role, prefix?: string) => users.find((u) => u.role === role && (!prefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(prefix)))!.id;
  Object.assign(ids, {
    operator: user("OPERATOR"),
    qc: user("QC"),
    hq: user("TRACE_OWNER"),
    ss1: user("SS", "SS-1"),
    ss2: user("SS", "SS-2"),
    SS1: partners.find((p) => p.name.startsWith("SS-1"))!.id,
    VW: partners.find((p) => p.name.startsWith("VW-1"))!.id,
    vw: users.find((u) => u.role === "WAREHOUSE")!.id,
  });
  const op = users.find((u) => u.id === ids.operator)!;
  await store().users.create({ ...op, id: "MF9998-OP", name: "Second operator" });
  ids.operator2 = "MF9998-OP";
}, 120_000);

afterAll(async () => {
  await closeStores();
  delete process.env.VELZA_DB_PATH;
  delete process.env.PGLITE_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

let firstOrder: string;
let firstBatch: string;

describe("allocation", () => {
  it("1–2. 100 lots are allocated once (00001…00064); the next allocation starts at 00065 (decimal 101)", async () => {
    const r = await created(createPrintOrder(ids.operator, { ...body(100), idempotencyKey: key() }));
    firstOrder = r.printOrder.id;
    firstBatch = r.printOrder.batchCodes[0];
    const lots = await lotsOf(firstOrder);
    expect(lots.map((l) => l.lotNumber)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect([lots[0].lotCode.slice(10), lots[99].lotCode.slice(10)]).toEqual(["00001", "00064"]);
    expect((await store().packs.list({ lotCode: lots.map((l) => l.lotCode) })).length).toBe(400);
    expect(await nextLotOf(firstBatch)).toBe(101);
    const next = await created(continueBatch(ids.operator, { batchCode: firstBatch, cases: 1, trays: 0, idempotencyKey: key() }));
    expect([next.firstLotHex, formatLotNumber(101)]).toEqual(["00065", "00065"]);
    expect(r.printOrder).toMatchObject({ id: expect.any(String), kind: "NEW_BATCH", requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("3. the same new-batch request repeated (in a row and at once) creates one order; the pool and counter move once", async () => {
    const k = key();
    const ordersBefore = (await store().printOrders.list()).length;
    const poolBefore = (await store().batchCodePool.list({ status: "USED" })).length;
    const a = await created(createPrintOrder(ids.operator, { ...body(3), idempotencyKey: k }));
    const b = await created(createPrintOrder(ids.operator, { ...body(3), idempotencyKey: k }));
    const many = await Promise.all(Array.from({ length: 5 }, () => created(createPrintOrder(ids.operator, { ...body(3), idempotencyKey: k }))));
    expect(new Set([a, b, ...many].map((x) => x.printOrder.id))).toEqual(new Set([k]));
    expect([a.replayed, b.replayed, ...many.map((m) => m.replayed)]).toEqual([false, true, true, true, true, true, true]);
    expect((await store().printOrders.list()).length).toBe(ordersBefore + 1);
    expect((await store().batchCodePool.list({ status: "USED" })).length).toBe(poolBefore + 1);
    expect(await nextLotOf(a.printOrder.batchCodes[0])).toBe(4);
  });

  it("3b. a new-batch order without a key is refused", async () => {
    await expect(createPrintOrder(ids.operator, body(1))).rejects.toMatchObject({ status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("4. the same key with different parameters is a conflict (new batch and continuation), and allocates nothing", async () => {
    const k = key();
    await createPrintOrder(ids.operator, { ...body(2), idempotencyKey: k });
    const before = await integrity();
    const orders = (await store().printOrders.list()).length;
    await expect(createPrintOrder(ids.operator, { ...body(3), idempotencyKey: k })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(createPrintOrder(ids.operator, { ...body(2, 0, "GA"), idempotencyKey: k })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
    const c = key();
    await continueBatch(ids.operator, { batchCode: firstBatch, cases: 1, trays: 0, idempotencyKey: c });
    const counter = await nextLotOf(firstBatch);
    await expect(continueBatch(ids.operator, { batchCode: firstBatch, cases: 2, trays: 0, idempotencyKey: c })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
    // a continuation key can't replay as a new-batch order either
    await expect(createPrintOrder(ids.operator, { ...body(1), idempotencyKey: c })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(await nextLotOf(firstBatch)).toBe(counter);
    expect((await store().printOrders.list()).length).toBe(orders + 1);
    expect(await integrity()).toEqual(before);
  });

  it("5. 10 simultaneous continuations and 10 simultaneous new-batch orders: distinct, adjacent, no duplicate", async () => {
    const start = await nextLotOf(firstBatch);
    const cont = await Promise.all(Array.from({ length: 10 }, (_, i) => created(continueBatch(i % 2 ? ids.operator2 : ids.operator, { batchCode: firstBatch, cases: 10, trays: 0, idempotencyKey: key() }))));
    const numbers = (await Promise.all(cont.map((c) => lotsOf(c.printOrder.id)))).flat().map((l) => l.lotNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 100 }, (_, i) => start + i));
    expect(await nextLotOf(firstBatch)).toBe(start + 100);
    const fresh = await Promise.all(Array.from({ length: 10 }, () => created(createPrintOrder(ids.operator, { ...body(1, 1), idempotencyKey: key() }))));
    expect(new Set(fresh.map((f) => f.printOrder.batchCodes[0])).size).toBe(10);
    expect(await integrity()).toEqual({ duplicateSerials: 0, codesInTwoOrders: 0, lotsOutsideTheirOrder: 0, badCounters: [] });
  });

  it("17. a new-batch order's id used as a continuation key is a conflict, never a replay", async () => {
    const counter = await nextLotOf(firstBatch);
    // same batch, same quantity (100 cases) as the order that created it: used to be "replayed"
    await expect(continueBatch(ids.operator, { batchCode: firstBatch, cases: 100, trays: 0, idempotencyKey: firstOrder })).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    expect(await nextLotOf(firstBatch)).toBe(counter);
  });
});

describe("storage-level guards", () => {
  it("15. a lot counter can't move backwards (store-level update, any caller)", async () => {
    const b = (await store().batches.findOne({ code: firstBatch }))!;
    await expect(store().batches.update(b.id, { nextLot: 1 })).rejects.toMatchObject({ name: "IntegrityError", code: "COUNTER_BACKWARDS" });
    await expect(store().batches.update(b.id, { nextLot: b.nextLot - 1 })).rejects.toMatchObject({ code: "COUNTER_BACKWARDS" });
    expect(await nextLotOf(firstBatch)).toBe(b.nextLot);
    await expect(store().batches.update(b.id, { nextLot: b.nextLot })).resolves.toMatchObject({ nextLot: b.nextLot }); // unchanged is fine
  });

  it("16. an issued lot or pack code can't be deleted", async () => {
    const [lot] = await lotsOf(firstOrder);
    const [pack] = await store().packs.list({ lotCode: lot.lotCode });
    await expect(store().lots.delete(lot.id)).rejects.toMatchObject({ name: "IntegrityError", code: "ISSUED_CODE_PROTECTED" });
    await expect(store().packs.delete(pack.id)).rejects.toMatchObject({ code: "ISSUED_CODE_PROTECTED" });
    expect(await store().lots.get(lot.id)).not.toBeNull();
    expect(await store().packs.get(pack.id)).not.toBeNull();
  });
});

describe("printing", () => {
  it("18. interrupted print: the committed order stays; a retry with the same key replays it; the sheet prints until confirmed", async () => {
    const k = key();
    await createPrintOrder(ids.operator, { ...body(2), idempotencyKey: k }); // response "lost"
    const retry = await created(createPrintOrder(ids.operator, { ...body(2), idempotencyKey: k }));
    expect([retry.replayed, retry.printOrder.status]).toEqual([true, "CREATED"]);
    // the printer jammed: open the sheet again (still CREATED) — allowed, and each serving is logged
    const first = await stickersForOrder(ids.operator, k);
    const again = await stickersForOrder(ids.operator, k);
    expect([first.stickers.length, again.stickers.length]).toEqual([10, 10]);
    expect((await store().movements.list({ type: "PRINT_SHEET_SERVED" })).filter((m) => m.itemCode === k)).toHaveLength(2);
    expect((await lotsOf(k)).map((l) => l.status)).toEqual(["GENERATED", "GENERATED"]);
  });

  it("9. once confirmed PRINTED, the order's sheet is not served again", async () => {
    await markPrinted(ids.operator, firstOrder);
    await expect(stickersForOrder(ids.operator, firstOrder)).rejects.toMatchObject({ status: 409, code: "ORDER_ALREADY_PRINTED" });
  });

  it("first-time sheets leave out voided lots; an order with nothing left to print is refused", async () => {
    const o = await created(createPrintOrder(ids.operator, { ...body(2), idempotencyKey: key() }));
    const [l1, l2] = await lotsOf(o.printOrder.id);
    await voidLot(ids.operator, { lotCode: l1.lotCode, reason: "misprint" });
    const sheet = await stickersForOrder(ids.operator, o.printOrder.id);
    expect(sheet.stickers.map((s) => s.code)).not.toContain(l1.lotCode);
    expect(sheet.stickers[0].code).toBe(l2.lotCode);
    expect(sheet.withheldLots).toBe(1);
    await voidLot(ids.operator, { lotCode: l2.lotCode, reason: "misprint" });
    await expect(stickersForOrder(ids.operator, o.printOrder.id)).rejects.toMatchObject({ status: 409, code: "NOTHING_TO_PRINT" });
  });

  it("cases printed first, then trays: the confirmed case run is not reported as voided or recalled, and the title counts the whole order", async () => {
    // 3 cases (1 + 4 stickers each) and 1 tray (1 + 6) = 22 stickers.
    const o = await created(createPrintOrder(ids.operator, { ...body(3, 1), idempotencyKey: key() }));
    const full = await stickersForOrder(ids.operator, o.printOrder.id);
    expect([full.stickers.length, full.withheldLots, full.title]).toEqual([22, 0, expect.stringContaining("· 22 stickers")]);
    await markPrinted(ids.operator, o.printOrder.id, { lotType: "CASE" });
    const trays = await stickersForOrder(ids.operator, o.printOrder.id);
    expect(trays.stickers).toHaveLength(7); // only the tray run is still to print
    expect(trays.withheldLots).toBe(0); // was 3: printed cases were counted as "voided or recalled"
    expect(trays.title).toContain("· 22 stickers");
    const notes = (await store().movements.list({ type: "PRINT_SHEET_SERVED" })).filter((m) => m.itemCode === o.printOrder.id).map((m) => m.note);
    expect(notes.some((n) => n?.includes("voided/recalled"))).toBe(false);
    // A really voided lot is still reported as withheld, and left out of the title count.
    const o2 = await created(createPrintOrder(ids.operator, { ...body(2), idempotencyKey: key() }));
    const [v] = await lotsOf(o2.printOrder.id);
    await voidLot(ids.operator, { lotCode: v.lotCode, reason: "misprint" });
    const sheet2 = await stickersForOrder(ids.operator, o2.printOrder.id);
    expect([sheet2.withheldLots, sheet2.title]).toEqual([1, expect.stringContaining("· 5 stickers")]);
  });

  it("8. a single sticker by code (the old direct endpoint) is refused", () => {
    expect(() => stickerByCodeRefused()).toThrow(expect.objectContaining({ status: 410, code: "REPRINT_REQUIRED" }));
  });
});

describe("reprint", () => {
  it("10. a reprint without a reason is refused", async () => {
    const [lot] = await lotsOf(firstOrder);
    await expect(reprint(ids.operator, { code: lot.lotCode, reason: "  " })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("11, 12, 14. a logged reprint prints once, with a full audit; reuse (in a row or at once) is refused", async () => {
    const [lot] = await lotsOf(firstOrder);
    const code = `${lot.lotCode}62`;
    const before = { lots: (await store().lots.list()).length, packs: (await store().packs.list()).length };
    const r = await reprint(ids.operator, { code, reason: "Sticker torn while pasting" });
    expect(r.reprint).toMatchObject({ code, itemKind: "PACK", reason: "Sticker torn while pasting", userId: ids.operator, printOrderId: firstOrder });
    expect(r.reprint.deviceId).toBeTruthy();
    expect(Date.parse(r.reprint.at)).toBeGreaterThan(Date.now() - 60_000);

    const results = await Promise.allSettled([serveReprint(ids.operator, r.reprint.id), serveReprint(ids.operator, r.reprint.id), serveReprint(ids.operator, r.reprint.id)]);
    const ok = results.filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(results.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason.code)).toEqual(["REPRINT_ALREADY_USED", "REPRINT_ALREADY_USED"]);
    const sheet = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof serveReprint>>>).value;
    expect(sheet.stickers.map((s) => s.code)).toEqual([code]);
    await expect(serveReprint(ids.operator, r.reprint.id)).rejects.toMatchObject({ status: 409, code: "REPRINT_ALREADY_USED" });

    const served = await store().movements.list({ id: reprintServedId(r.reprint.id) });
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ type: "REPRINT_SERVED", itemCode: code, userId: ids.operator });
    expect(served[0].note).toContain(firstOrder.slice(0, 8));
    const log = (await listReprints(ids.operator)).find((x) => x.id === r.reprint.id)!;
    expect(log.servedAt).toBe(served[0].at);
    // same code, no new serial
    expect({ lots: (await store().lots.list()).length, packs: (await store().packs.list()).length }).toEqual(before);
  });

  it("only the plant's operator can use a reprint; another role or nobody is refused", async () => {
    const [lot] = await lotsOf(firstOrder);
    const r = await reprint(ids.operator, { code: lot.lotCode, reason: "smudged" });
    await expect(serveReprint(ids.qc, r.reprint.id)).rejects.toMatchObject({ status: 403 });
    await expect(serveReprint(null, r.reprint.id)).rejects.toMatchObject({ status: 401 });
    await expect(serveReprint(ids.operator, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it("13. VOID and RECALLED codes can't be reprinted; a logged reprint whose code is voided afterwards no longer prints", async () => {
    const o = await created(createPrintOrder(ids.operator, { ...body(2), idempotencyKey: key() }));
    await markPrinted(ids.operator, o.printOrder.id);
    const [l1, l2] = await lotsOf(o.printOrder.id);
    const pending = await reprint(ids.operator, { code: l1.lotCode, reason: "torn" });
    await voidLot(ids.operator, { lotCode: l1.lotCode, reason: "misprint" });
    await expect(reprint(ids.operator, { code: l1.lotCode, reason: "again" })).rejects.toMatchObject({ code: "WRONG_STATUS" });
    await expect(serveReprint(ids.operator, pending.reprint.id)).rejects.toMatchObject({ status: 409, code: "WRONG_STATUS" });
    await recall(ids.hq, { batchCode: l2.batchCode, reason: "audit recall" });
    expect((await store().lots.findOne({ lotCode: l2.lotCode }))!.status).toBe("RECALLED");
    await expect(reprint(ids.operator, { code: `${l2.lotCode}61`, reason: "torn" })).rejects.toMatchObject({ code: "WRONG_STATUS" });
    // retired numbers never come back
    expect(await nextLotOf(l2.batchCode)).toBe(3);
  });
});

describe("existing workflows", () => {
  it("19. QC, dispatch, receive still work on new orders; a dispatched code can't be reprinted", async () => {
    const o = await created(createPrintOrder(ids.operator, { ...body(1), idempotencyKey: key() }));
    await stickersForOrder(ids.operator, o.printOrder.id);
    await markPrinted(ids.operator, o.printOrder.id);
    const [lot] = await lotsOf(o.printOrder.id);
    expect(await qcVerify(lot.lotCode)).toMatchObject({ ok: true });
    // The plant ships only to the Velza Warehouse; the warehouse sends it on to SS-1.
    expect(await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.VW, invoice: "SER-0", codes: [lot.lotCode] })).toMatchObject({ ok: true });
    await expect(reprint(ids.operator, { code: lot.lotCode, reason: "torn" })).rejects.toMatchObject({ code: "WRONG_STATUS" });
    expect(await receive(ids.vw, { code: lot.lotCode })).toMatchObject({ ok: true });
    expect(await dispatch(ids.vw, { action: "confirm", toPartnerId: ids.SS1, invoice: "SER-1", codes: [lot.lotCode] })).toMatchObject({ ok: true });
    expect(await receive(ids.ss2, { code: lot.lotCode })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    expect(await receive(ids.ss1, { code: lot.lotCode })).toMatchObject({ ok: true });
    expect(await receive(ids.ss1, { code: lot.lotCode })).toMatchObject({ ok: false, code: "DUPLICATE_RECEIPT" });
  });

  it("final: zero duplicate serials, every code in exactly one order, every counter consistent", async () => {
    expect(await integrity()).toEqual({ duplicateSerials: 0, codesInTwoOrders: 0, lotsOutsideTheirOrder: 0, badCounters: [] });
  });
});

describe.runIf(isJson)("7. JSON file: one process owns it", () => {
  const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const probe = (dbPath: string) =>
    JSON.parse(
      execFileSync(process.execPath, [tsx, "tests/fixtures/jsonLockProbe.ts"], { env: { ...process.env, STORE: "json", VELZA_DB_PATH: dbPath }, encoding: "utf8", timeout: 60_000 })
        .trim()
        .split("\n")
        .at(-1)!,
    ) as { ok: boolean; error?: string; message?: string };

  it("a second process is refused while this one owns the file; it may open it once released", async () => {
    await store().getSettings(); // this process owns the file
    const lockFile = `${path.resolve(process.env.VELZA_DB_PATH!)}.lock`;
    expect(JSON.parse(await fs.readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    const refused = probe(process.env.VELZA_DB_PATH!);
    expect(refused).toMatchObject({ ok: false, error: "JsonStoreLockedError" });
    expect(refused.message).toContain(`pid ${process.pid}`);

    await closeStores(); // releases the lock
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(probe(process.env.VELZA_DB_PATH!)).toMatchObject({ ok: true });
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" }); // the child released it on exit
    expect(await integrity()).toEqual({ duplicateSerials: 0, codesInTwoOrders: 0, lotsOutsideTheirOrder: 0, badCounters: [] });
  }, 120_000);

  it("a lock left by a process that no longer exists is taken over", async () => {
    const other = path.join(dir, "stale.json");
    writeFileSync(`${other}.lock`, JSON.stringify({ pid: 2_147_000_000, host: os.hostname(), startedAt: "2026-11-01T00:00:00.000Z", token: "dead" }));
    expect(probe(other)).toMatchObject({ ok: true });
  }, 60_000);

  it("a write is refused (nothing saved) if the file changed on disk during the transaction", async () => {
    const before = (await store().printOrders.list()).length;
    await expect(
      store().transaction(async (tx) => {
        await tx.printOrders.list();
        // another writer (an editor, a copy) replaces the file meanwhile
        const raw = await fs.readFile(process.env.VELZA_DB_PATH!, "utf8");
        await new Promise((r) => setTimeout(r, 20));
        await fs.writeFile(process.env.VELZA_DB_PATH!, `${raw} `);
        await tx.users.update(ids.operator, { name: "changed" });
      }),
    ).rejects.toMatchObject({ name: "ConcurrentWriteError" });
    expect((await store().users.get(ids.operator))!.name).not.toBe("changed");
    expect((await store().printOrders.list()).length).toBe(before);
  });
});
