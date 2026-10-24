import { describe, expect, it } from "vitest";
import { planPrintOrder, type BatchInput } from "./printOrder";

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

  it("flags 0 cases and 0 trays", () => {
    const plan = planPrintOrder({ batches: [b({})], country: "91", poolCodes: ["AAA111"], flavours });
    expect(plan.ok).toBe(false);
    expect(plan.errors[0].message).toMatch(/both are 0/);
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
});
