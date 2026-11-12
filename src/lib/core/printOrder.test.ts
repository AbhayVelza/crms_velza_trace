import { describe, expect, it } from "vitest";
import { planPrintOrder, summarizePlan, type BatchInput } from "./printOrder";

const flavours = ["OR", "GA", "NS", "MN"];
const b = (over: Partial<BatchInput>): BatchInput => ({
  flavour: "OR",
  mfgDate: "2026-10-01",
  expiryDate: "2027-04-01",
  cases: 0,
  trays: 0,
  ...over,
});

describe("planPrintOrder", () => {
  it("demo script summary: Original 2 cases + 1 tray, Green Apple 1 tray → 24 stickers", () => {
    const plan = planPrintOrder({
      batches: [b({ cases: 2, trays: 1 }), b({ flavour: "GA", trays: 1 })],
      country: "91",
      poolCodes: ["AAA111", "BBB222", "CCC333"],
      flavours,
    });
    expect(plan.ok).toBe(true);
    expect(plan.batches[0]).toMatchObject({
      batchCode: "AAA111",
      lotRange: ["00001", "00003"],
      caseRange: ["00001", "00002"],
      trayRange: ["00003", "00003"],
      stickerCount: 17,
    });
    expect(plan.batches[1]).toMatchObject({ batchCode: "BBB222", lotRange: ["00001", "00001"], stickerCount: 7 });
    expect(plan.batches[1].lots[0].lotCode).toBe("91BBB222GA00001");
    expect(plan.totalStickers).toBe(24);
    expect(plan.totalLots).toBe(4);
  });

  it("50 cases + 20 trays → 390 stickers", () => {
    const plan = planPrintOrder({ batches: [b({ cases: 50, trays: 20 })], country: "91", poolCodes: ["AAA111"], flavours });
    expect(plan.totalStickers).toBe(390);
    expect(plan.batches[0].caseRange).toEqual(["00001", "00032"]);
    expect(plan.batches[0].trayRange).toEqual(["00033", "00046"]);
  });

  it("cases and trays may each be 0, even both in one batch, as long as the order prints something", () => {
    const onlyTrays = planPrintOrder({ batches: [b({ cases: 0, trays: 2 })], country: "91", poolCodes: ["AAA111"], flavours });
    expect(onlyTrays).toMatchObject({ ok: true, totalStickers: 14 });
    const mixed = planPrintOrder({ batches: [b({ cases: 1 }), b({})], country: "91", poolCodes: ["AAA111", "BBB222"], flavours });
    expect(mixed.ok).toBe(true);
    expect(mixed.batches[1]).toMatchObject({ batchCode: "BBB222", lots: [], lotRange: null, stickerCount: 0 });
  });

  it("flags an order with nothing to print, and counts that are not 0 or a whole number", () => {
    const empty = planPrintOrder({ batches: [b({}), b({})], country: "91", poolCodes: ["AAA111", "BBB222"], flavours });
    expect(empty.ok).toBe(false);
    expect(empty.errors.map((e) => e.message)).toEqual([expect.stringMatching(/Nothing to print/)]);
    for (const bad of [-1, 1.5, NaN]) {
      const p = planPrintOrder({ batches: [b({ cases: bad, trays: 1 })], country: "91", poolCodes: ["AAA111"], flavours });
      expect(p.errors[0].message).toMatch(/0 or a whole number/);
    }
  });

  it("flags an empty or short pool", () => {
    const empty = planPrintOrder({ batches: [b({ cases: 1 })], country: "91", poolCodes: [], flavours });
    expect(empty.ok).toBe(false);
    expect(empty.errors[0].message).toMatch(/pool is empty/);
    const short = planPrintOrder({ batches: [b({ cases: 1 }), b({ cases: 1 })], country: "91", poolCodes: ["AAA111"], flavours });
    expect(short.errors[0].message).toMatch(/only 1 code/);
    expect(short.batches[1].batchCode).toBeNull();
  });

  it("flags bad flavour, dates and counts", () => {
    const plan = planPrintOrder({
      batches: [
        b({ flavour: "XX", cases: 1 }),
        b({ mfgDate: "2026-13-01", cases: 1 }),
        b({ expiryDate: "2026-09-01", cases: 1 }),
        b({ cases: -1 }),
      ],
      country: "91",
      poolCodes: ["A00001", "A00002", "A00003", "A00004"],
      flavours,
    });
    const fields = plan.errors.map((e) => `${e.batchIndex}:${e.field}`);
    expect(fields).toEqual(["0:flavour", "1:mfgDate", "2:expiryDate", "3:cases"]);
  });

  it("requires at least one batch", () => {
    expect(planPrintOrder({ batches: [], country: "91", poolCodes: ["A"], flavours }).ok).toBe(false);
  });

  it("refuses an order over the lot cap as a whole (never truncates); exactly the cap is fine", () => {
    const pool = ["AAA111", "BBB222"];
    const at = planPrintOrder({ batches: [b({ cases: 600 }), b({ trays: 400 })], country: "91", poolCodes: pool, flavours, maxLotsPerOrder: 1000 });
    expect(at.ok).toBe(true);
    expect(at.totalLots).toBe(1000);
    const over = planPrintOrder({ batches: [b({ cases: 600 }), b({ trays: 401 })], country: "91", poolCodes: pool, flavours, maxLotsPerOrder: 1000, maxLotsNote: " on the JSON file store" });
    expect(over.ok).toBe(false);
    expect(over.errors).toEqual([{ batchIndex: null, field: "batches", message: expect.stringMatching(/^At most 1,000 lots per print order on the JSON file store; requested 1,001/) }]);
    // Nothing is allocated over the cap, but the summary still says what was asked for.
    expect(over.batches.every((x) => x.lots.length === 0)).toBe(true);
    expect(over.totalLots).toBe(1001);
    expect(over.batches[1]).toMatchObject({ lotCount: 401, trayRange: ["00001", "00191"], lotRange: ["00001", "00191"] });
  });

  it("refuses a manufacture date in the future and an implausible shelf life, each on its own field", () => {
    const today = "2026-11-04";
    const plan = planPrintOrder({
      batches: [
        b({ mfgDate: "2026-11-06", expiryDate: "2027-11-06", cases: 1 }), // 2 days ahead
        b({ mfgDate: "2026-11-01", expiryDate: "2026-11-01", cases: 1 }), // expiry = manufacture
        b({ mfgDate: "2026-11-01", expiryDate: "2036-11-01", cases: 1 }), // 10 years
        b({ mfgDate: "2026-11-05", expiryDate: "2031-11-05", cases: 1 }), // tomorrow (time zones) and exactly 5 years: fine
      ],
      country: "91",
      poolCodes: ["A00001", "A00002", "A00003", "A00004"],
      flavours,
      today,
    });
    expect(plan.errors.map((e) => `${e.batchIndex}:${e.field}`)).toEqual(["0:mfgDate", "1:expiryDate", "2:expiryDate"]);
    expect(plan.errors[0].message).toMatch(/in the future/);
    expect(plan.errors[2].message).toMatch(/more than 5 years/);
    // Without today (core callers, older tests) the future check is off.
    expect(planPrintOrder({ batches: [b({ mfgDate: "2030-01-01", expiryDate: "2031-01-01", cases: 1 })], country: "91", poolCodes: ["AAA111"], flavours }).ok).toBe(true);
  });

  it("the summary sent to the screen carries ranges and counts, never every code", () => {
    const plan = planPrintOrder({ batches: [b({ cases: 99_000, trays: 999 })], country: "91", poolCodes: ["AAA111"], flavours });
    expect(plan.batches[0].lots).toHaveLength(99_999);
    const summary = summarizePlan(plan);
    expect(summary.batches[0]).not.toHaveProperty("lots");
    expect(summary.batches[0]).toMatchObject({ lotCount: 99_999, lotRange: ["00001", "1869F"], firstLotCode: "91AAA111OR00001", lastLotCode: "91AAA111OR1869F" });
    expect(summary.totalStickers).toBe(plan.totalStickers);
    expect(JSON.stringify(summary).length).toBeLessThan(2_000);
  });
});
