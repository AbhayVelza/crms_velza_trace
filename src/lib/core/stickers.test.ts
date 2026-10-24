import { describe, expect, it } from "vitest";
import { lotStickerHeader, packStickerHeader, qrUrlFor, stickerForCode, stickersForLots } from "./stickers";

describe("stickers", () => {
  it("headers match the spec", () => {
    expect(lotStickerHeader("CASE", "Original")).toBe("CASE | ORIGINAL | 4 x 6 = 24 CANS");
    expect(lotStickerHeader("TRAY", "Green Apple")).toBe("TRAY | GREEN APPLE | 6 x 4 = 24 CANS");
    expect(packStickerHeader("CASE", 2)).toBe("PACK 2 of 4 | 6 CANS");
    expect(packStickerHeader("TRAY", 6)).toBe("PACK 6 of 6 | 4 CANS");
  });

  it("QR encodes base URL + /t/ + lot code", () => {
    expect(qrUrlFor("http://localhost:3000/", "91ABC123OR00001")).toBe("http://localhost:3000/t/91ABC123OR00001");
  });

  it("orders lot sticker first then its packs; case = 5, tray = 7", () => {
    const s = stickersForLots(
      [
        { lotCode: "91ABC123OR00001", lotType: "CASE", flavourName: "Original" },
        { lotCode: "91ABC123OR00002", lotType: "TRAY", flavourName: "Original" },
      ],
      "http://x",
    );
    expect(s).toHaveLength(12);
    expect(s.map((x) => x.kind).join(",")).toBe("LOT,PACK,PACK,PACK,PACK,LOT,PACK,PACK,PACK,PACK,PACK,PACK");
    expect(s[1].code).toBe("91ABC123OR0000161");
    expect(s[6].code).toBe("91ABC123OR0000241");
  });

  it("reprint returns the same code", () => {
    const lot = { lotCode: "91ABC123OR00001", lotType: "CASE" as const, flavourName: "Original" };
    expect(stickerForCode("91ABC123OR0000163", lot, "http://x")?.header).toBe("PACK 3 of 4 | 6 CANS");
    expect(stickerForCode("91ABC123OR00001", lot, "http://x")?.kind).toBe("LOT");
  });
});
