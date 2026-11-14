// Alerts are computed from the scan audit log, damage reports and current in-transit items, never stored.
// What HQ did about an alert (acknowledge, close, reopen) is stored: append-only ALERT_* rows of the movement
// ledger, keyed by the alert id (applyAlertState). Alert ids are therefore stable across recomputations.

import { ALERT_RESULT_CODES } from "./rules";
import type { ItemKind, Movement, Scan, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export const ALERT_TYPES = [
  "NOT_RECEIVED",
  "WRONG_RECEIVER",
  "UNKNOWN_CODE",
  "DUPLICATE_RECEIPT",
  "BLOCKED_CODE",
  "DAMAGED",
  // Public (consumer) page: computeCloneAlerts / computePublicSummaryAlerts below.
  "SUSPECT_CLONE",
  "PUBLIC_UNKNOWN",
  "PUBLIC_BLOCKED",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export interface Alert {
  id: string;
  type: AlertType;
  at: string;
  code: string;
  message: string;
  partnerId: string | null;
  userId: string | null;
  /** Repeated failed scans folded into this alert (collapseAlerts): how many, first and last time. Absent when 1. */
  count?: number;
  firstAt?: string;
  lastAt?: string;
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
  /** DAMAGED movements: every damage report reaches HQ as an alert. */
  damageReports?: Pick<Movement, "id" | "at" | "itemKind" | "itemCode" | "fromId" | "userId" | "note">[];
  settings: Pick<Settings, "demoMode" | "demoThresholdMinutes" | "notReceivedThresholdDays">;
  now: Date;
}

/** Newest first. */
export function computeAlerts({ scans, inTransit, damageReports = [], settings, now }: ComputeAlertsInput): Alert[] {
  const alerts: Alert[] = [];
  const threshold = notReceivedThresholdMs(settings);
  for (const u of inTransit) {
    const age = ageMs(u.dispatchedAt, now);
    if (age > threshold) {
      alerts.push({
        // One alert per dispatch: a code dispatched again later is a new alert, so acknowledging one never hides the next.
        id: `NR-${u.code}-${u.dispatchedAt}`,
        type: "NOT_RECEIVED",
        at: new Date(new Date(u.dispatchedAt).getTime() + threshold).toISOString(),
        code: u.code,
        message: `${u.kind === "LOT" ? "Lot" : "Pack"} ${u.code} in transit for ${formatAge(age)} (threshold ${formatAge(threshold)})`,
        partnerId: u.toId,
        userId: null,
      });
    }
  }
  const scanAlerts: Alert[] = [];
  for (const s of scans) {
    if (alertWorthyScan(s)) {
      scanAlerts.push({
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
  alerts.push(...collapseAlerts(scanAlerts, scans));
  for (const m of damageReports) {
    alerts.push({
      id: `DM-${m.id}`,
      type: "DAMAGED",
      at: m.at,
      code: m.itemCode,
      message: `${m.itemKind === "PACK" ? "Pack" : "Lot"} ${m.itemCode} reported damaged${m.note ? `: ${m.note}` : ""}`,
      partnerId: m.fromId,
      userId: m.userId,
    });
  }
  return alerts.sort((a, b) => b.at.localeCompare(a.at));
}

const ALERT_CODES: readonly string[] = ALERT_RESULT_CODES;

/**
 * A failed scan HQ should be alerted about. HQ's own trace searches (context LOOKUP) are audited but never alert:
 * a mistyped search is not a field event.
 */
export function alertWorthyScan(s: Pick<Scan, "ok" | "result" | "context">): boolean {
  return !s.ok && ALERT_CODES.includes(s.result) && s.context !== "LOOKUP";
}

/** Repeated failed scans of one code by one partner in one context fold into one alert per window (fixed buckets). */
export const ALERT_COLLAPSE_WINDOW_MS = 60 * 60_000;

/**
 * Folds scan alerts of the same type, code, partner and scan context inside one fixed time bucket into one alert.
 * The group keeps the id of its first scan (stable, so an acknowledgement still applies when more scans join),
 * the latest message and time, and count / firstAt / lastAt. Buckets are fixed (floor(time / window)), so a group
 * never merges with another one later. `scans` gives each alert's context (by id `SC-<scan id>`).
 */
export function collapseAlerts(alerts: Alert[], scans: Pick<Scan, "id" | "context">[] = [], windowMs = ALERT_COLLAPSE_WINDOW_MS): Alert[] {
  const contextOf = new Map(scans.map((s) => [`SC-${s.id}`, s.context]));
  const groups = new Map<string, Alert[]>();
  for (const a of alerts) {
    const bucket = Math.floor(new Date(a.at).getTime() / windowMs);
    const key = [a.type, a.code, a.partnerId ?? "", contextOf.get(a.id) ?? "", bucket].join("|");
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return g[0];
    const byTime = [...g].sort((a, b) => a.at.localeCompare(b.at));
    const first = byTime[0];
    const last = byTime[byTime.length - 1];
    return { ...last, id: first.id, count: g.length, firstAt: first.at, lastAt: last.at };
  });
}

/**
 * Pure throttle for callers that log scans from untrusted sources: given the recent scans of one key (e.g. one
 * code on the public page), whether to record another, and how many were suppressed in the window.
 */
export function scanThrottle(recent: Pick<Scan, "at">[], now: Date, { windowMs, max }: { windowMs: number; max: number }): { record: boolean; suppressed: number } {
  const inWindow = recent.filter((s) => now.getTime() - new Date(s.at).getTime() < windowMs).length;
  return { record: inWindow < max, suppressed: Math.max(0, inWindow - max) };
}

// ---------------------------------------------------------------- acknowledge / close

export const ALERT_STATES = ["OPEN", "ACKNOWLEDGED", "CLOSED"] as const;
export type AlertState = (typeof ALERT_STATES)[number];
export const ALERT_ACTIONS = ["ACKNOWLEDGE", "CLOSE", "REOPEN"] as const;
export type AlertActionName = (typeof ALERT_ACTIONS)[number];

/** Ledger movement type for each action (itemKind "ALERT", itemCode = alert id). */
export const ALERT_ACTION_MOVEMENT = {
  ACKNOWLEDGE: "ALERT_ACKNOWLEDGED",
  CLOSE: "ALERT_CLOSED",
  REOPEN: "ALERT_REOPENED",
} as const satisfies Record<AlertActionName, Movement["type"]>;
export const ALERT_ACTION_MOVEMENT_TYPES: Movement["type"][] = Object.values(ALERT_ACTION_MOVEMENT);

const STATE_AFTER: Partial<Record<Movement["type"], AlertState>> = { ALERT_ACKNOWLEDGED: "ACKNOWLEDGED", ALERT_CLOSED: "CLOSED", ALERT_REOPENED: "OPEN" };

export type AlertActionRow = Pick<Movement, "at" | "type" | "itemCode" | "userId" | "note">;

export interface AlertHistoryEntry {
  at: string;
  state: AlertState;
  userId: string | null;
  note: string | null;
}

export type StatefulAlert<A extends Alert = Alert> = A & {
  state: AlertState;
  stateAt: string | null;
  stateBy: string | null;
  stateNote: string | null;
  history: AlertHistoryEntry[];
};

/** Whether `action` is allowed from `state`: acknowledge an open alert, close an open or acknowledged one, reopen otherwise. */
export function canApplyAlertAction(state: AlertState, action: AlertActionName): boolean {
  if (action === "ACKNOWLEDGE") return state === "OPEN";
  if (action === "CLOSE") return state !== "CLOSED";
  return state !== "OPEN";
}

/**
 * Each alert's state from the latest action on its id (history kept, oldest first). An alert acknowledged or
 * closed before its latest occurrence (a collapsed group that grew, a public summary with new scans) is OPEN again.
 */
export function applyAlertState<A extends Alert>(alerts: A[], actions: AlertActionRow[]): StatefulAlert<A>[] {
  const byAlert = new Map<string, AlertHistoryEntry[]>();
  for (const m of [...actions].sort((a, b) => a.at.localeCompare(b.at))) {
    const state = STATE_AFTER[m.type];
    if (!state) continue;
    const entry = { at: m.at, state, userId: m.userId, note: m.note };
    const list = byAlert.get(m.itemCode);
    if (list) list.push(entry);
    else byAlert.set(m.itemCode, [entry]);
  }
  return alerts.map((a) => {
    const history = byAlert.get(a.id) ?? [];
    const latest = history.at(-1);
    const newer = !!latest && (a.lastAt ?? a.at) > latest.at;
    const state: AlertState = !latest || newer ? "OPEN" : latest.state;
    return { ...a, state, stateAt: latest?.at ?? null, stateBy: latest?.userId ?? null, stateNote: latest?.note ?? null, history };
  });
}

// ---------------------------------------------------------------- public (consumer) scans
// Added for REF-13 / LOW-public-unknown-flood. Consumer scans store no identity (no IP, user or device), so these
// alerts carry counts and times only. Each one has a stable id, so repeated scans never add more alerts.

/** Alert types raised from public-page scans. The HQ alerts owner adds these to ALERT_TYPES when wiring them in. */
export const PUBLIC_ALERT_TYPES = ["SUSPECT_CLONE", "PUBLIC_UNKNOWN", "PUBLIC_BLOCKED"] as const;
export type PublicAlertType = (typeof PUBLIC_ALERT_TYPES)[number];
export type PublicAlert = Omit<Alert, "type"> & { type: PublicAlertType };

/** PROVISIONAL — needs Velza business approval: unknown public codes per UTC day before HQ gets one summary alert. */
export const PUBLIC_UNKNOWN_ALERT_MIN = 10;

const HOUR_MS = 60 * 60_000;
type CloneSettings = Partial<Pick<Settings, "publicCloneScanThreshold" | "publicCloneWindowHours">>;

export function publicCloneLimits(settings: CloneSettings): { threshold: number; windowMs: number; windowHours: number } {
  const threshold = Math.max(2, Math.floor(settings.publicCloneScanThreshold ?? DEFAULT_SETTINGS.publicCloneScanThreshold ?? 5));
  const windowHours = Math.max(1, settings.publicCloneWindowHours ?? DEFAULT_SETTINGS.publicCloneWindowHours ?? 24);
  return { threshold, windowMs: windowHours * HOUR_MS, windowHours };
}

/** Public scans that found a registered code (genuine, blocked or unreleased), i.e. a real sticker or a copy of one. */
function isRegisteredPublicScan(s: Scan): boolean {
  if (s.context !== "PUBLIC_LOOKUP") return false;
  return s.ok || s.result === "PUBLIC_BLOCKED" || s.result === "PUBLIC_UNRELEASED" || s.result === "BLOCKED_CODE";
}

/**
 * SUSPECT_CLONE: one code scanned on the public page at least `threshold` times within any `window` (sliding).
 * At most one alert per code (id `CL-<code>`), whatever the number of scans. `now` bounds the scans considered.
 */
export function computeCloneAlerts(scans: Scan[], settings: CloneSettings, now: Date): PublicAlert[] {
  const { threshold, windowMs, windowHours } = publicCloneLimits(settings);
  const byCode = new Map<string, number[]>();
  for (const s of scans) {
    if (!isRegisteredPublicScan(s)) continue;
    const t = new Date(s.at).getTime();
    if (!(t <= now.getTime())) continue;
    let list = byCode.get(s.code);
    if (!list) byCode.set(s.code, (list = []));
    list.push(t);
  }
  const alerts: PublicAlert[] = [];
  for (const [code, times] of byCode) {
    if (times.length < threshold) continue;
    times.sort((a, b) => a - b);
    // Largest number of scans inside one window, and where that window starts.
    let best = 0;
    let bestStart = 0;
    let firstOver = -1; // index of the scan that first reached the threshold
    for (let i = 0, j = 0; j < times.length; j++) {
      while (times[j] - times[i] > windowMs) i++;
      const n = j - i + 1;
      if (n > best) [best, bestStart] = [n, i];
      if (firstOver < 0 && n >= threshold) firstOver = j;
    }
    if (best < threshold) continue;
    const first = new Date(times[bestStart]).toISOString();
    const last = new Date(times[bestStart + best - 1]).toISOString();
    alerts.push({
      id: `CL-${code}`,
      type: "SUSPECT_CLONE",
      at: new Date(times[firstOver]).toISOString(),
      code,
      message: `Code ${code} was checked ${best} times on the public page within ${windowHours} h (${first} to ${last}; threshold ${threshold}): the QR sticker may have been copied`,
      partnerId: null,
      userId: null,
    });
  }
  return alerts.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Aggregated alerts for public scans that are not genuine, so made-up codes cannot flood HQ:
 *   - PUBLIC_UNKNOWN: one alert per UTC day (id `PU-<yyyy-mm-dd>`) once that day has `unknownMin` unknown codes;
 *   - PUBLIC_BLOCKED: one alert per code (id `PB-<code>`) scanned by consumers while recalled, quarantined, damaged,
 *     returned, void or not yet released, with the number of scans and the last time.
 * Only rows written with the public result codes (rules.ts publicScanOutcome) count; partner scans are untouched.
 */
export function computePublicSummaryAlerts(scans: Scan[], now: Date, unknownMin = PUBLIC_UNKNOWN_ALERT_MIN): PublicAlert[] {
  const unknownByDay = new Map<string, { n: number; codes: Set<string>; last: string }>();
  const blocked = new Map<string, { n: number; last: string; message: string }>();
  for (const s of scans) {
    if (s.context !== "PUBLIC_LOOKUP" || s.ok || !(new Date(s.at).getTime() <= now.getTime())) continue;
    if (s.result === "PUBLIC_UNKNOWN") {
      const day = s.at.slice(0, 10);
      const d = unknownByDay.get(day) ?? { n: 0, codes: new Set<string>(), last: s.at };
      d.n++;
      d.codes.add(s.code);
      if (s.at > d.last) d.last = s.at;
      unknownByDay.set(day, d);
    } else if (s.result === "PUBLIC_BLOCKED" || s.result === "PUBLIC_UNRELEASED") {
      const b = blocked.get(s.code) ?? { n: 0, last: s.at, message: s.message };
      b.n++;
      if (s.at >= b.last) [b.last, b.message] = [s.at, s.message];
      blocked.set(s.code, b);
    }
  }
  const alerts: PublicAlert[] = [];
  for (const [day, d] of unknownByDay) {
    if (d.n < Math.max(1, unknownMin)) continue;
    alerts.push({
      id: `PU-${day}`,
      type: "PUBLIC_UNKNOWN",
      at: d.last,
      code: "",
      message: `${d.n} public checks of ${d.codes.size} unknown code(s) on ${day} (UTC): possible counterfeit stickers or code guessing`,
      partnerId: null,
      userId: null,
    });
  }
  for (const [code, b] of blocked) {
    alerts.push({
      id: `PB-${code}`,
      type: "PUBLIC_BLOCKED",
      at: b.last,
      code,
      message: `${b.message} (${b.n} public check${b.n === 1 ? "" : "s"})`,
      partnerId: null,
      userId: null,
    });
  }
  return alerts.sort((a, b) => b.at.localeCompare(a.at));
}
