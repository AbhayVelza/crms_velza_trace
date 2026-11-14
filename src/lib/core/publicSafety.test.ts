// Public QR page safety (pure rules): what a consumer is told, how a consumer scan is logged, and the aggregated
// HQ alerts for consumer scans (clone suspicion, unknown codes, blocked codes) that cannot be flooded.

import { describe, expect, it } from "vitest";
import { codeFromParam, MAX_CODE_PARAM } from "@/app/t/[code]/codeParam";
import { MAX_SCAN_INPUT, publicScanInput } from "@/lib/scan/normalize";
import { scannedCodeSchema } from "@/lib/scan/scannedCode";
import { computeCloneAlerts, computePublicSummaryAlerts, PUBLIC_UNKNOWN_ALERT_MIN } from "./alerts";
import { ALERT_RESULT_CODES, PUBLIC_GENUINE_STATUSES, PUBLIC_SCAN_RESULTS, publicScanOutcome, publicStatus } from "./rules";
import { ITEM_STATUSES, type ItemStatus, type Scan } from "./types";

const LOT = "91BMMU03OR00001";
const PACK = "91BMMU03OR0000161";

describe("publicStatus (allowlist)", () => {
  const expected: Record<ItemStatus, { label: string; tone: "ok" | "warn" | "danger" }> = {
    GENERATED: { label: "Not yet released", tone: "warn" },
    PRINTED: { label: "Not yet released", tone: "warn" },
    PACKED: { label: "Genuine Velza product", tone: "ok" },
    IN_TRANSIT: { label: "Genuine Velza product", tone: "ok" },
    AT_WAREHOUSE: { label: "Genuine Velza product", tone: "ok" },
    AT_SS: { label: "Genuine Velza product", tone: "ok" },
    AT_DB: { label: "Genuine Velza product", tone: "ok" },
    AT_RETAILER: { label: "Genuine Velza product", tone: "ok" },
    OPENED: { label: "Genuine Velza product", tone: "ok" },
    QUARANTINED: { label: "Not for sale — do not consume", tone: "danger" },
    DAMAGED: { label: "Not for sale — do not consume", tone: "danger" },
    RETURNED: { label: "Withdrawn — do not consume", tone: "danger" },
    RECALLED: { label: "Recalled — do not consume", tone: "danger" },
    VOID: { label: "Unregistered code", tone: "warn" },
  };

  it.each([...ITEM_STATUSES])("%s", (status) => {
    expect(publicStatus(true, status)).toEqual(expected[status]);
  });

  it("only the allowlist is ever genuine", () => {
    const genuine = ITEM_STATUSES.filter((s) => publicStatus(true, s).tone === "ok");
    expect(genuine).toEqual([...PUBLIC_GENUINE_STATUSES]);
    expect(publicStatus(true, "SOMETHING_NEW" as ItemStatus)).toEqual({ label: "Unregistered code", tone: "warn" });
    expect(publicStatus(false, null)).toEqual({ label: "Unregistered code", tone: "warn" });
  });
});

describe("publicScanOutcome (how a consumer scan is logged)", () => {
  it("only genuine stock is ok; everything else is a public, non-alerting result", () => {
    for (const status of ITEM_STATUSES) {
      const o = publicScanOutcome(LOT, status);
      expect(o.ok).toBe(PUBLIC_GENUINE_STATUSES.includes(status));
      if (!o.ok) expect(PUBLIC_SCAN_RESULTS).toContain(o.result);
    }
    expect(publicScanOutcome(LOT, "DAMAGED")).toMatchObject({ ok: false, result: "PUBLIC_BLOCKED", message: `Public scan of DAMAGED code ${LOT}` });
    expect(publicScanOutcome(LOT, "RETURNED")).toMatchObject({ ok: false, result: "PUBLIC_BLOCKED" });
    expect(publicScanOutcome(LOT, "PRINTED")).toMatchObject({ ok: false, result: "PUBLIC_UNRELEASED" });
    expect(publicScanOutcome(LOT, null)).toMatchObject({ ok: false, result: "PUBLIC_UNKNOWN" });
  });
  it("public result codes never raise a per-scan alert", () => {
    for (const r of PUBLIC_SCAN_RESULTS) expect(ALERT_RESULT_CODES as readonly string[]).not.toContain(r);
  });
});

let n = 0;
const scan = (code: string, at: string, over: Partial<Scan> = {}): Scan => ({
  id: `SC${++n}`,
  at,
  context: "PUBLIC_LOOKUP",
  code,
  ok: true,
  result: "OK",
  message: "Genuine Velza product",
  userId: null,
  partnerId: null,
  deviceId: null,
  ...over,
});
const at = (h: number) => new Date(Date.UTC(2026, 10, 4, 0, 0, 0) + h * 3_600_000).toISOString();
const NOW = new Date(Date.UTC(2026, 10, 20));

describe("computeCloneAlerts (SUSPECT_CLONE)", () => {
  const settings = { publicCloneScanThreshold: 5, publicCloneWindowHours: 24 };

  it("7 public checks of one code inside the window → exactly one alert, with the count and no identity", () => {
    const scans = Array.from({ length: 7 }, (_, i) => scan(LOT, at(i)));
    const alerts = computeCloneAlerts(scans, settings, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: `CL-${LOT}`, type: "SUSPECT_CLONE", code: LOT, partnerId: null, userId: null, at: at(4) });
    expect(alerts[0].message).toMatch(/checked 7 times/);
    expect(alerts[0].message).toMatch(/threshold 5/);
    expect(alerts[0].message).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no IP
  });

  it("the same 7 spread outside the window → no alert; threshold-1 inside the window → no alert", () => {
    expect(computeCloneAlerts(Array.from({ length: 7 }, (_, i) => scan(LOT, at(i * 25))), settings, NOW)).toEqual([]);
    expect(computeCloneAlerts(Array.from({ length: 4 }, (_, i) => scan(LOT, at(i))), settings, NOW)).toEqual([]);
  });

  it("counts blocked/unreleased checks of a real code too, but not unknown codes, partner scans or future rows", () => {
    const scans = [
      ...Array.from({ length: 3 }, (_, i) => scan(PACK, at(i))),
      scan(PACK, at(3), { ok: false, result: "PUBLIC_BLOCKED" }),
      scan(PACK, at(4), { ok: false, result: "PUBLIC_UNRELEASED" }),
      ...Array.from({ length: 9 }, (_, i) => scan("91ZZZZZZOR00001", at(i), { ok: false, result: "PUBLIC_UNKNOWN" })),
      ...Array.from({ length: 9 }, (_, i) => scan(LOT, at(i), { context: "RECEIVE" })),
    ];
    expect(computeCloneAlerts(scans, settings, NOW).map((a) => a.code)).toEqual([PACK]);
    expect(computeCloneAlerts(scans, settings, new Date(at(3.5)))).toEqual([]);
  });

  it("thresholds come from settings, with the provisional defaults when unset", () => {
    const scans = Array.from({ length: 5 }, (_, i) => scan(LOT, at(i)));
    expect(computeCloneAlerts(scans, {}, NOW)).toHaveLength(1); // default 5 in 24 h
    expect(computeCloneAlerts(scans, { publicCloneScanThreshold: 6 }, NOW)).toEqual([]);
    expect(computeCloneAlerts(scans, { publicCloneWindowHours: 2 }, NOW)).toEqual([]);
  });
});

describe("computePublicSummaryAlerts (no flooding)", () => {
  it("500 made-up codes in one day → one PUBLIC_UNKNOWN alert", () => {
    const scans = Array.from({ length: 500 }, (_, i) => scan(`91ZZZZZZOR${String(i).padStart(5, "0")}`, at(i / 100), { ok: false, result: "PUBLIC_UNKNOWN" }));
    const alerts = computePublicSummaryAlerts(scans, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: "PU-2026-11-04", type: "PUBLIC_UNKNOWN", partnerId: null, userId: null });
    expect(alerts[0].message).toMatch(/^500 public checks of 500 unknown code/);
  });

  it("a few unknown codes stay below the provisional minimum", () => {
    const scans = Array.from({ length: PUBLIC_UNKNOWN_ALERT_MIN - 1 }, (_, i) => scan(`X${i}`, at(i), { ok: false, result: "PUBLIC_UNKNOWN" }));
    expect(computePublicSummaryAlerts(scans, NOW)).toEqual([]);
  });

  it("one PUBLIC_BLOCKED alert per code, with the number of consumer checks", () => {
    const scans = [
      ...Array.from({ length: 30 }, (_, i) => scan(LOT, at(i), { ok: false, result: "PUBLIC_BLOCKED", message: `Public scan of RECALLED code ${LOT}` })),
      scan(PACK, at(1), { ok: false, result: "PUBLIC_UNRELEASED", message: `Public scan of PRINTED code ${PACK}` }),
    ];
    const alerts = computePublicSummaryAlerts(scans, NOW);
    expect(alerts.map((a) => [a.id, a.type])).toEqual([
      [`PB-${LOT}`, "PUBLIC_BLOCKED"],
      [`PB-${PACK}`, "PUBLIC_BLOCKED"],
    ]);
    expect(alerts[0].message).toBe(`Public scan of RECALLED code ${LOT} (30 public checks)`);
  });

  it("partner scans and genuine public checks are ignored", () => {
    const scans = [scan(LOT, at(1)), scan(LOT, at(1), { context: "RECEIVE", ok: false, result: "UNKNOWN_CODE" })];
    expect(computePublicSummaryAlerts(scans, NOW)).toEqual([]);
  });
});

describe("public input bounds", () => {
  it("publicScanInput: only a well-formed code is looked up and logged", () => {
    expect(publicScanInput(`https://velza.example/t/${LOT.toLowerCase()}\r\n`)).toEqual({ code: LOT, loggable: true });
    expect(publicScanInput(PACK)).toEqual({ code: PACK, loggable: true });
    expect(publicScanInput("hello")).toMatchObject({ loggable: false });
    expect(publicScanInput("%E0%A4%A")).toMatchObject({ loggable: false });
    const long = publicScanInput("A".repeat(10_000));
    expect(long).toEqual({ code: "", loggable: false });
    expect(publicScanInput("B".repeat(200)).code.length).toBeLessThanOrEqual(40);
  });

  it("scannedCodeSchema normalises a QR link and refuses over-long input", () => {
    expect(scannedCodeSchema.parse(`https://x/t/${LOT.toLowerCase()}\r\n`)).toBe(LOT);
    expect(scannedCodeSchema.parse(`\t${PACK} `)).toBe(PACK);
    expect(() => scannedCodeSchema.parse("A".repeat(MAX_SCAN_INPUT + 44))).toThrow(/Not a Velza code/);
  });

  it("the /t/<code> page decodes once and never throws on a broken % sequence", () => {
    expect(codeFromParam("%E0%A4%A")).toBe("%E0%A4%A");
    expect(codeFromParam(encodeURIComponent(LOT))).toBe(LOT);
    expect(codeFromParam("%2541")).toBe("%41"); // decoded once only
    expect(codeFromParam("A".repeat(5000)).length).toBe(MAX_CODE_PARAM + 1);
  });
});
