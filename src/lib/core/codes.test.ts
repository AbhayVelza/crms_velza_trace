import { describe, expect, it } from "vitest";
import {
  allocateLots,
  BATCH_CODE_CHARS,
  buildLotCode,
  buildPackCodes,
  extractScannedCode,
  formatLotNumber,
  generateBatchCode,
  parseCode,
  parseLotNumber,
  stickerCount,
} from "./codes";

describe("formatLotNumber / parseLotNumber", () => {
  it("formats boundaries as 5 uppercase hex chars", () => {
    expect(formatLotNumber(1)).toBe("00001");
    expect(formatLotNumber(15)).toBe("0000F");
    expect(formatLotNumber(16)).toBe("00010");
    expect(formatLotNumber(0x1869f)).toBe("1869F");
    expect(formatLotNumber(99_999)).toBe("1869F");
    expect(formatLotNumber(0xabc)).toBe("00ABC");
  });

  it("0000F is followed by 00010", () => {
    expect(formatLotNumber(parseLotNumber("0000F") + 1)).toBe("00010");
  });

  it("rejects out-of-range or non-integer numbers", () => {
    expect(() => formatLotNumber(0)).toThrow();
    expect(() => formatLotNumber(-1)).toThrow();
    expect(() => formatLotNumber(0x186a0)).toThrow();
    expect(() => formatLotNumber(1.5)).toThrow();
    expect(() => formatLotNumber(Number.NaN)).toThrow();
  });

  it("parses valid hex", () => {
    expect(parseLotNumber("00001")).toBe(1);
    expect(parseLotNumber("0000F")).toBe(15);
    expect(parseLotNumber("00010")).toBe(16);
    expect(parseLotNumber("1869F")).toBe(99_999);
  });

  it("rejects 00000, 186A0, lowercase and wrong length", () => {
    expect(() => parseLotNumber("00000")).toThrow(/reserved/);
    expect(() => parseLotNumber("186A0")).toThrow(/maximum/);
    expect(() => parseLotNumber("FFFFF")).toThrow();
    expect(() => parseLotNumber("0000f")).toThrow(/uppercase/);
    expect(() => parseLotNumber("0001")).toThrow();
    expect(() => parseLotNumber("000001")).toThrow();
    expect(() => parseLotNumber("0000G")).toThrow();
    expect(() => parseLotNumber("")).toThrow();
  });
});

describe("generateBatchCode", () => {
  it("returns 6 uppercase alphanumeric chars", () => {
    for (let i = 0; i < 100; i++) expect(generateBatchCode(new Set())).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("no duplicates across 10,000 generated codes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateBatchCode(seen));
    expect(seen.size).toBe(10_000);
  });

  it("retries on collision", () => {
    // Deterministic RNG: first draw gives AAAAAA (taken), second gives BBBBBB.
    let call = 0;
    const rng = (n: number) => new Uint8Array(n).fill(call++ === 0 ? 0 : 1);
    expect(generateBatchCode(new Set(["AAAAAA"]), rng)).toBe("BBBBBB");
  });

  it("skips biased bytes (≥ 252)", () => {
    let call = 0;
    const rng = (n: number) => new Uint8Array(n).fill(call++ === 0 ? 255 : 35);
    expect(generateBatchCode(new Set(), rng)).toBe(BATCH_CODE_CHARS[35].repeat(6));
  });

  it("throws if every attempt collides", () => {
    const rng = (n: number) => new Uint8Array(n).fill(0);
    expect(() => generateBatchCode(new Set(["AAAAAA"]), rng)).toThrow(/unique/);
  });
});

describe("buildLotCode / buildPackCodes", () => {
  it("builds the spec example", () => {
    expect(buildLotCode({ country: "91", batch: "ABC123", flavour: "OR", lotNumber: 1 })).toBe("91ABC123OR00001");
  });

  it("rejects bad segments", () => {
    expect(() => buildLotCode({ country: "9", batch: "ABC123", flavour: "OR", lotNumber: 1 })).toThrow();
    expect(() => buildLotCode({ country: "91", batch: "abc123", flavour: "OR", lotNumber: 1 })).toThrow();
    expect(() => buildLotCode({ country: "91", batch: "ABC12", flavour: "OR", lotNumber: 1 })).toThrow();
    expect(() => buildLotCode({ country: "91", batch: "ABC123", flavour: "or", lotNumber: 1 })).toThrow();
    expect(() => buildLotCode({ country: "91", batch: "ABC123", flavour: "OR", lotNumber: 0 })).toThrow();
  });

  it("case → 4 packs of size 6", () => {
    expect(buildPackCodes("91ABC123OR00001", "CASE")).toEqual([
      "91ABC123OR0000161",
      "91ABC123OR0000162",
      "91ABC123OR0000163",
      "91ABC123OR0000164",
    ]);
  });

  it("tray → 6 packs of size 4", () => {
    const codes = buildPackCodes("91ABC123OR00001", "TRAY");
    expect(codes).toHaveLength(6);
    expect(codes[0]).toBe("91ABC123OR0000141");
    expect(codes[5]).toBe("91ABC123OR0000146");
  });

  it("rejects a non-lot code", () => {
    expect(() => buildPackCodes("91ABC123OR0000161", "CASE")).toThrow();
  });
});

describe("parseCode", () => {
  it("parses a lot code", () => {
    const r = parseCode("91ABC123OR00001");
    expect(r).toEqual({
      ok: true,
      value: { kind: "LOT", country: "91", batch: "ABC123", flavour: "OR", lotHex: "00001", lotNumber: 1, lotCode: "91ABC123OR00001" },
    });
  });

  it("parses pack codes for both sizes", () => {
    const c = parseCode("91ABC123OR0000164");
    expect(c.ok && c.value).toMatchObject({ kind: "PACK", packSize: 6, packSeq: 4, lotCode: "91ABC123OR00001" });
    const t = parseCode("91ZZ9Z99GA1869F46");
    expect(t.ok && t.value).toMatchObject({ kind: "PACK", packSize: 4, packSeq: 6, flavour: "GA", lotHex: "1869F" });
  });

  it("accepts every default flavour", () => {
    for (const f of ["OR", "GA", "NS", "MN"]) expect(parseCode(`91ABC123${f}00001`).ok).toBe(true);
  });

  const bad: [string, string, string][] = [
    ["", "EMPTY", "empty"],
    ["91ABC123OR0001", "BAD_LENGTH", "14 chars"],
    ["91ABC123OR000011", "BAD_LENGTH", "16 chars"],
    ["91ABC123OR000016100", "BAD_LENGTH", "19 chars"],
    ["44ABC123OR00001", "BAD_COUNTRY", "unknown country"],
    ["9AABC123OR00001", "BAD_COUNTRY", "non-digit country"],
    ["91abc123OR00001", "BAD_BATCH", "lowercase batch"],
    ["91ABC-23OR00001", "BAD_BATCH", "symbol in batch"],
    ["91ABC123XX00001", "BAD_FLAVOUR", "unknown flavour"],
    ["91ABC123or00001", "BAD_FLAVOUR", "lowercase flavour"],
    ["91ABC123O100001", "BAD_FLAVOUR", "digit in flavour"],
    ["91ABC123OR00000", "BAD_LOT_NUMBER", "reserved 00000"],
    ["91ABC123OR186A0", "BAD_LOT_NUMBER", "above 1869F"],
    ["91ABC123OR0000a", "BAD_LOT_NUMBER", "lowercase hex"],
    ["91ABC123OR0000G", "BAD_LOT_NUMBER", "non-hex"],
    ["91ABC123OR0000151", "BAD_PACK_SIZE", "pack size 5"],
    ["91ABC123OR0000101", "BAD_PACK_SIZE", "pack size 0"],
    ["91ABC123OR0000165", "BAD_PACK_SEQ", "seq 5 for size 6"],
    ["91ABC123OR0000160", "BAD_PACK_SEQ", "seq 0 for size 6"],
    ["91ABC123OR0000147", "BAD_PACK_SEQ", "seq 7 for size 4"],
    ["91ABC123OR000014A", "BAD_PACK_SEQ", "letter seq"],
    ["91ABC123OR00000 1", "BAD_LOT_NUMBER", "pack of reserved lot"],
  ];
  it.each(bad)("rejects %s (%s: %s)", (code, err) => {
    const r = parseCode(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(err);
  });

  it("respects configured country and flavour lists", () => {
    expect(parseCode("44ABC123OR00001", { countries: ["91", "44"] }).ok).toBe(true);
    expect(parseCode("91ABC123LM00001", { flavours: ["LM"] }).ok).toBe(true);
    expect(parseCode("91ABC123OR00001", { flavours: ["LM"] }).ok).toBe(false);
  });
});

describe("extractScannedCode", () => {
  it("passes plain codes through (trimmed)", () => {
    expect(extractScannedCode("  91ABC123OR00001\r\n")).toBe("91ABC123OR00001");
  });
  it("takes the last path segment of a QR URL", () => {
    expect(extractScannedCode("http://localhost:3000/t/91ABC123OR00001")).toBe("91ABC123OR00001");
    expect(extractScannedCode("https://velza.example/t/91ABC123OR00001/?src=qr#x")).toBe("91ABC123OR00001");
  });
});

describe("allocateLots", () => {
  const batch = { code: "ABC123", country: "91", flavour: "OR", nextLot: 1 };

  it("50 cases + 20 trays → cases 00001–00032, trays 00033–00046, 390 stickers", () => {
    const { lots, nextLot } = allocateLots(batch, 50, 20);
    const cases = lots.filter((l) => l.lotType === "CASE");
    const trays = lots.filter((l) => l.lotType === "TRAY");
    expect(cases).toHaveLength(50);
    expect(trays).toHaveLength(20);
    expect(cases[0].lotHex).toBe("00001");
    expect(cases[49].lotHex).toBe("00032");
    expect(trays[0].lotHex).toBe("00033");
    expect(trays[19].lotHex).toBe("00046");
    expect(nextLot).toBe(71);
    expect(stickerCount(50, 20)).toBe(390);
    expect(lots.reduce((s, l) => s + 1 + l.packCodes.length, 0)).toBe(390);
  });

  it("cases first then trays, consecutive, no duplicate codes", () => {
    const { lots } = allocateLots(batch, 2, 1);
    expect(lots.map((l) => l.lotCode)).toEqual(["91ABC123OR00001", "91ABC123OR00002", "91ABC123OR00003"]);
    expect(lots.map((l) => l.lotType)).toEqual(["CASE", "CASE", "TRAY"]);
    expect(lots[2].packCodes[0]).toBe("91ABC123OR0000341");
    const all = lots.flatMap((l) => [l.lotCode, ...l.packCodes]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("continues from the batch counter", () => {
    const { lots, nextLot } = allocateLots({ ...batch, nextLot: 15 }, 1, 1);
    expect(lots.map((l) => l.lotHex)).toEqual(["0000F", "00010"]);
    expect(nextLot).toBe(17);
  });

  it("allows the last usable number and rejects overflow", () => {
    expect(allocateLots({ ...batch, nextLot: 0x1869f }, 1, 0).lots[0].lotHex).toBe("1869F");
    expect(() => allocateLots({ ...batch, nextLot: 0x1869f }, 1, 1)).toThrow(/1869F/);
  });

  it("rejects negative or fractional counts", () => {
    expect(() => allocateLots(batch, -1, 0)).toThrow();
    expect(() => allocateLots(batch, 0, 1.5)).toThrow();
  });

  it("returns nothing for 0 + 0", () => {
    expect(allocateLots(batch, 0, 0)).toEqual({ lots: [], nextLot: 1 });
  });
});
