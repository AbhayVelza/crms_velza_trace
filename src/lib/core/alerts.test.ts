import { describe, expect, it } from "vitest";
import { computeAlerts, formatAge, notReceivedThresholdMs } from "./alerts";
import type { Scan } from "./types";

const settings = { demoMode: false, demoThresholdMinutes: 5, notReceivedThresholdDays: 3 };
const now = new Date("2026-10-10T12:00:00.000Z");

const scan = (over: Partial<Scan>): Scan => ({
  id: "s1",
  at: "2026-10-10T11:00:00.000Z",
  context: "RECEIVE",
  code: "91ABC123OR00001",
  ok: false,
  result: "WRONG_RECEIVER",
  message: "not for you",
  userId: "u1",
  partnerId: "ss2",
  deviceId: null,
  ...over,
});

describe("alerts", () => {
  it("threshold is days normally and minutes in demo mode", () => {
    expect(notReceivedThresholdMs(settings)).toBe(3 * 86_400_000);
    expect(notReceivedThresholdMs({ ...settings, demoMode: true })).toBe(5 * 60_000);
  });

  it("NOT_RECEIVED only after the threshold", () => {
    const unit = (code: string, dispatchedAt: string) => ({ kind: "LOT" as const, code, fromId: "mfg", toId: "ss1", dispatchedAt });
    const alerts = computeAlerts({
      scans: [],
      inTransit: [unit("OLD", "2026-10-06T12:00:00.000Z"), unit("NEW", "2026-10-09T12:00:00.000Z")],
      settings,
      now,
    });
    expect(alerts.map((a) => a.code)).toEqual(["OLD"]);
    expect(alerts[0].type).toBe("NOT_RECEIVED");

    const demo = computeAlerts({
      scans: [],
      inTransit: [unit("NEW", "2026-10-10T11:50:00.000Z")],
      settings: { ...settings, demoMode: true },
      now,
    });
    expect(demo).toHaveLength(1);
  });

  it("raises alerts from failed scans of the alert types only", () => {
    const alerts = computeAlerts({
      scans: [
        scan({ id: "a", result: "WRONG_RECEIVER" }),
        scan({ id: "b", result: "UNKNOWN_CODE", at: "2026-10-10T11:30:00.000Z" }),
        scan({ id: "c", result: "DUPLICATE_RECEIPT" }),
        scan({ id: "d", result: "BLOCKED_CODE" }),
        scan({ id: "e", result: "WRONG_STATUS" }),
        scan({ id: "f", result: "OK", ok: true }),
      ],
      inTransit: [],
      settings,
      now,
    });
    expect(alerts.map((a) => a.type).sort()).toEqual(["BLOCKED_CODE", "DUPLICATE_RECEIPT", "UNKNOWN_CODE", "WRONG_RECEIVER"]);
    expect(alerts[0].type).toBe("UNKNOWN_CODE"); // newest first
  });

  it("formats ages", () => {
    expect(formatAge(5 * 60_000)).toBe("5m");
    expect(formatAge(3 * 3_600_000 + 60_000)).toBe("3h 1m");
    expect(formatAge(3 * 86_400_000)).toBe("3d 0h");
  });
});
