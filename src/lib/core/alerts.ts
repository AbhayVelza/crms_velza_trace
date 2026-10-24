// Alerts are computed from the scan audit log and current in-transit items, never stored.

import { ALERT_RESULT_CODES } from "./rules";
import type { ItemKind, Scan, Settings } from "./types";

export const ALERT_TYPES = ["NOT_RECEIVED", "WRONG_RECEIVER", "UNKNOWN_CODE", "DUPLICATE_RECEIPT", "BLOCKED_CODE"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export interface Alert {
  id: string;
  type: AlertType;
  at: string;
  code: string;
  message: string;
  partnerId: string | null;
  userId: string | null;
}

export interface InTransitUnit {
  kind: ItemKind;
  code: string;
  fromId: string;
  toId: string;
  dispatchedAt: string;
}

export function notReceivedThresholdMs(settings: Pick<Settings, "demoMode" | "demoThresholdMinutes" | "notReceivedThresholdDays">): number {
  return settings.demoMode
    ? settings.demoThresholdMinutes * 60_000
    : settings.notReceivedThresholdDays * 24 * 60 * 60_000;
}

export function ageMs(fromIso: string, now: Date): number {
  return now.getTime() - new Date(fromIso).getTime();
}

export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface ComputeAlertsInput {
  scans: Scan[];
  inTransit: InTransitUnit[];
  settings: Pick<Settings, "demoMode" | "demoThresholdMinutes" | "notReceivedThresholdDays">;
  now: Date;
}

/** Newest first. */
export function computeAlerts({ scans, inTransit, settings, now }: ComputeAlertsInput): Alert[] {
  const alerts: Alert[] = [];
  const threshold = notReceivedThresholdMs(settings);
  for (const u of inTransit) {
    const age = ageMs(u.dispatchedAt, now);
    if (age > threshold) {
      alerts.push({
        id: `NR-${u.code}`,
        type: "NOT_RECEIVED",
        at: new Date(new Date(u.dispatchedAt).getTime() + threshold).toISOString(),
        code: u.code,
        message: `${u.kind === "LOT" ? "Lot" : "Pack"} ${u.code} in transit for ${formatAge(age)} (threshold ${formatAge(threshold)})`,
        partnerId: u.toId,
        userId: null,
      });
    }
  }
  const alertCodes: readonly string[] = ALERT_RESULT_CODES;
  for (const s of scans) {
    if (!s.ok && alertCodes.includes(s.result)) {
      alerts.push({
        id: `SC-${s.id}`,
        type: s.result as AlertType,
        at: s.at,
        code: s.code,
        message: s.message,
        partnerId: s.partnerId,
        userId: s.userId,
      });
    }
  }
  return alerts.sort((a, b) => b.at.localeCompare(a.at));
}
