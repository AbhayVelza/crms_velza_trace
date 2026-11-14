// Live scan checklist: the codes an operation expects (loaded from the server) and what each scan did to them.
// Pure functions; a status only changes from a server answer, never from a client-side match.

export type ChecklistStatus = "PENDING" | "SCANNED" | "INVALID" | "DUPLICATE" | "BLOCKED";

export interface ChecklistItem {
  code: string;
  kind: "LOT" | "PACK";
  /** Short description shown next to the code (e.g. "Case · Original"). */
  label?: string;
  /** Optional group (e.g. the invoice an incoming item was dispatched on). */
  group?: string | null;
}

export interface ChecklistRow extends ChecklistItem {
  status: ChecklistStatus;
  message: string | null;
}

/** A scan the server refused for a code that is not on the list (e.g. a pack of another lot). */
export interface StrayScan {
  code: string;
  status: Exclude<ChecklistStatus, "PENDING" | "SCANNED">;
  message: string;
}

export interface ChecklistState {
  rows: ChecklistRow[];
  index: Map<string, number>;
  strays: StrayScan[];
}

/**
 * Result codes (`RejectCode` in src/lib/core/rules.ts) where a real code is refused by a business rule: recalled /
 * quarantined / void (BLOCKED_CODE), not printed, unsynced, wrong receiver, wrong place or status. Everything else
 * (unknown or malformed code, pack of another lot, missing invoice …) is INVALID.
 */
const BLOCKING = new Set(["BLOCKED_CODE", "NOT_PRINTED", "UNSYNCED", "WRONG_RECEIVER", "NOT_AT_LOCATION", "WRONG_STATUS", "WRONG_DESTINATION", "LOT_SEALED", "LOT_OPENED", "NOT_ALLOWED"]);
const DUPLICATES = new Set(["DUPLICATE_SCAN", "DUPLICATE_RECEIPT"]);

/** Server result code → checklist status for a refused scan. */
export function statusForRejection(resultCode: string | undefined): Exclude<ChecklistStatus, "PENDING" | "SCANNED"> {
  if (resultCode && DUPLICATES.has(resultCode)) return "DUPLICATE";
  if (resultCode && BLOCKING.has(resultCode)) return "BLOCKED";
  return "INVALID";
}

export function createChecklist(items: ChecklistItem[]): ChecklistState {
  const rows: ChecklistRow[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    if (index.has(item.code)) continue; // one row per code, first occurrence keeps its place
    index.set(item.code, rows.length);
    rows.push({ ...item, status: "PENDING", message: null });
  }
  return { rows, index, strays: [] };
}

/** Add codes that appeared since the list was loaded (e.g. a new delivery), keeping existing rows and their order. */
export function mergeExpected(state: ChecklistState, items: ChecklistItem[]): ChecklistState {
  const fresh = items.filter((i) => !state.index.has(i.code));
  if (!fresh.length) return state;
  const rows = [...state.rows];
  const index = new Map(state.index);
  for (const item of fresh) {
    if (index.has(item.code)) continue;
    index.set(item.code, rows.length);
    rows.push({ ...item, status: "PENDING", message: null });
  }
  return { ...state, rows, index };
}

function withRow(state: ChecklistState, i: number, row: ChecklistRow): ChecklistState {
  const rows = state.rows.slice();
  rows[i] = row;
  return { ...state, rows };
}

/** The server accepted the scan of `code`. */
export function applyAccepted(state: ChecklistState, code: string, message: string | null = null): ChecklistState {
  const i = state.index.get(code);
  if (i === undefined) return state; // accepted but not expected here: nothing on the list to tick
  return withRow(state, i, { ...state.rows[i], status: "SCANNED", message });
}

/** The server refused the scan of `code` with `resultCode`. A row already SCANNED stays SCANNED (a repeat never undoes it). */
export function applyRejected(state: ChecklistState, code: string, resultCode: string | undefined, message: string): ChecklistState {
  const status = statusForRejection(resultCode);
  const i = state.index.get(code);
  if (i === undefined) return { ...state, strays: [{ code, status, message }, ...state.strays.filter((s) => s.code !== code)].slice(0, 200) };
  const row = state.rows[i];
  if (row.status === "SCANNED") return state;
  return withRow(state, i, { ...row, status, message });
}

/** Undo a client-side selection (e.g. "Remove" from a dispatch list before confirming). */
export function resetItem(state: ChecklistState, code: string): ChecklistState {
  const i = state.index.get(code);
  if (i === undefined) return state;
  return withRow(state, i, { ...state.rows[i], status: "PENDING", message: null });
}

export interface ChecklistCounts {
  expected: number;
  scanned: number;
  pending: number;
  /** Refused scans: rows marked INVALID/DUPLICATE/BLOCKED plus refused codes that are not on the list. */
  rejected: number;
  percent: number;
  complete: boolean;
}

export function countChecklist(state: ChecklistState): ChecklistCounts {
  let scanned = 0;
  let rejectedRows = 0;
  for (const r of state.rows) {
    if (r.status === "SCANNED") scanned++;
    else if (r.status !== "PENDING") rejectedRows++;
  }
  const expected = state.rows.length;
  return {
    expected,
    scanned,
    pending: expected - scanned,
    rejected: rejectedRows + state.strays.length,
    percent: expected ? Math.floor((scanned / expected) * 100) : 0,
    complete: expected > 0 && scanned === expected,
  };
}

export type ChecklistFilter = "ALL" | "SCANNED" | "PENDING" | "INVALID";

/** Filter + search, in the list's stable order. "PENDING" = not scanned yet (including refused rows). */
export function filterRows(state: ChecklistState, filter: ChecklistFilter, search: string): ChecklistRow[] {
  const q = search.trim().toUpperCase();
  return state.rows.filter((r) => {
    if (filter === "SCANNED" && r.status !== "SCANNED") return false;
    if (filter === "PENDING" && r.status === "SCANNED") return false;
    if (filter === "INVALID" && (r.status === "SCANNED" || r.status === "PENDING")) return false;
    return !q || r.code.includes(q) || (r.label ?? "").toUpperCase().includes(q) || (r.group ?? "").toUpperCase().includes(q);
  });
}

export function pageOf<T>(rows: T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(p * size, p * size + size), page: p, pages };
}

/** Index of the first row not yet scanned (to keep the next pending code in view), or -1. */
export function nextPending(state: ChecklistState): number {
  return state.rows.findIndex((r) => r.status !== "SCANNED");
}

/**
 * The expected list was reloaded from the server: rows follow the new list (its order), codes still on it keep the
 * status this session gave them, codes that left it are dropped unless `keep` says otherwise (e.g. a received item
 * that is no longer "incoming" but should stay visible as SCANNED until the page is left).
 */
export function rebaseChecklist(state: ChecklistState, items: ChecklistItem[], keep: (row: ChecklistRow) => boolean = () => false): ChecklistState {
  const next = createChecklist(items);
  const rows = next.rows.map((r) => {
    const i = state.index.get(r.code);
    return i === undefined ? r : { ...r, status: state.rows[i].status, message: state.rows[i].message };
  });
  const kept = state.rows.filter((r) => !next.index.has(r.code) && keep(r));
  const all = [...rows, ...kept];
  return { rows: all, index: new Map(all.map((r, i) => [r.code, i])), strays: state.strays };
}

/** Back to "nothing scanned" (e.g. the destination changed or the dispatch was confirmed); the expected rows stay. */
export function resetAll(state: ChecklistState): ChecklistState {
  return { ...state, rows: state.rows.map((r) => (r.status === "PENDING" ? r : { ...r, status: "PENDING" as const, message: null })), strays: [] };
}
