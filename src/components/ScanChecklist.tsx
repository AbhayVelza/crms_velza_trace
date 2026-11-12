"use client";

// Live scanned / not-scanned list under a scanner. The page owns the state (src/lib/scan/checklist.ts) and changes it
// only from server answers; this component only shows it: counters, progress, filters, search and paging.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { countChecklist, createChecklist, filterRows, pageOf, type ChecklistFilter, type ChecklistItem, type ChecklistState, type ChecklistStatus } from "@/lib/scan/checklist";

/**
 * Checklist state with a synchronous mirror: queued scans run back to back, so handlers must read the latest list
 * (e.g. the packs already accepted, which QC sends to the server for its duplicate check), not a stale render's.
 */
export function useChecklist(initial: ChecklistItem[] = []) {
  const [state, setState] = useState(() => createChecklist(initial));
  const ref = useRef(state);
  const update = useCallback((fn: (s: ChecklistState) => ChecklistState) => {
    ref.current = fn(ref.current);
    setState(ref.current);
  }, []);
  const reset = useCallback((items: ChecklistItem[]) => {
    ref.current = createChecklist(items);
    setState(ref.current);
  }, []);
  return { state, ref, update, reset };
}
import { IconBan, IconCheck, IconCircleX, IconClock, IconRotateCcw } from "./icons";
import { Button, Code, cx, Input, Notice } from "./ui";

const PAGE_SIZE = 50;

const STATUS: Record<ChecklistStatus, { label: string; className: string; Icon: typeof IconCheck }> = {
  PENDING: { label: "PENDING", className: "border-line bg-surface-2 text-muted-foreground", Icon: IconClock },
  SCANNED: { label: "SCANNED", className: "border-success-line bg-success-soft text-success", Icon: IconCheck },
  INVALID: { label: "INVALID", className: "border-danger-line bg-danger-soft text-danger", Icon: IconCircleX },
  DUPLICATE: { label: "DUPLICATE", className: "border-warning-line bg-warning-soft text-warning", Icon: IconRotateCcw },
  BLOCKED: { label: "BLOCKED", className: "border-danger-line bg-danger-soft text-danger", Icon: IconBan },
};

export function ChecklistStatusBadge({ status }: { status: ChecklistStatus }) {
  const s = STATUS[status];
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold tracking-[0.04em]", s.className)}>
      <s.Icon size={12} aria-hidden="true" />
      {s.label}
    </span>
  );
}

const FILTERS: { value: ChecklistFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "SCANNED", label: "Scanned" },
  { value: "PENDING", label: "Pending" },
  { value: "INVALID", label: "Invalid" },
];

interface Props {
  state: ChecklistState;
  /** What the list is (e.g. "Packs in this case"). */
  title?: string;
  /** Shown when every expected code is scanned (the page still decides what the final action is). */
  completeText?: ReactNode;
  /** Shown when there is nothing to expect. */
  emptyText?: ReactNode;
  /** Group label column heading (e.g. "Invoice"); omitted when no row has a group. */
  groupLabel?: string;
  /** Per-row action (e.g. "Remove" from a dispatch list). */
  rowAction?: (code: string) => ReactNode;
}

export function ScanChecklist({ state, title = "Expected codes", completeText, emptyText = "Nothing expected", groupLabel = "Group", rowAction }: Props) {
  const [filter, setFilter] = useState<ChecklistFilter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const counts = countChecklist(state);
  const shown = useMemo(() => filterRows(state, filter, search), [state, filter, search]);
  const view = pageOf(shown, page, PAGE_SIZE);
  const hasGroups = state.rows.some((r) => r.group);
  const big = state.rows.length > 10;

  return (
    <section className="min-w-0 space-y-3" aria-label={title} data-testid="scan-checklist" data-complete={counts.complete}>
      <div className="sticky top-0 z-[1] -mx-1 space-y-2 bg-surface px-1 pb-2 pt-1">
        <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4" data-testid="checklist-counts">
          <Counter label="Expected" value={counts.expected} name="expected" />
          <Counter label="Scanned" value={counts.scanned} name="scanned" tone="ok" />
          <Counter label="Pending" value={counts.pending} name="pending" />
          <Counter label="Invalid / rejected" value={counts.rejected} name="rejected" tone={counts.rejected ? "bad" : undefined} />
        </dl>
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label={`${title}: scanned`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={counts.percent}
            aria-valuetext={`${counts.scanned} of ${counts.expected} scanned (${counts.percent}%)`}
            className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted-strong"
          >
            <div className="h-full rounded-full bg-success transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${counts.percent}%` }} />
          </div>
          <span className="text-sm font-semibold tabular" data-testid="checklist-percent">
            {counts.percent}%
          </span>
        </div>
      </div>

      {counts.complete && completeText && (
        <Notice tone="ok" className="!mt-1">
          <span data-testid="checklist-complete">{completeText}</span>
        </Notice>
      )}

      {state.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          {big && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex flex-wrap gap-0.5 rounded-full border border-line-strong bg-surface-2 p-0.5" role="radiogroup" aria-label="Show">
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    role="radio"
                    aria-checked={filter === f.value}
                    onClick={() => (setFilter(f.value), setPage(0))}
                    className={filter === f.value ? "min-h-9 rounded-full bg-primary px-3.5 text-sm font-semibold text-primary-foreground" : "min-h-9 rounded-full px-3.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <Input
                type="search"
                aria-label="Find a code in the list"
                placeholder="Find code…"
                value={search}
                onChange={(e) => (setSearch(e.target.value), setPage(0))}
                className="min-h-9 w-full font-mono text-sm sm:w-56"
              />
            </div>
          )}
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-[0.05em] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Code</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  {hasGroups && <th className="px-3 py-2 font-semibold">{groupLabel}</th>}
                  <th className="px-3 py-2 font-semibold">Status</th>
                  {rowAction && <th className="px-3 py-2" aria-label="Actions" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {view.rows.map((r) => (
                  <tr key={r.code} data-testid="checklist-row" data-code={r.code} data-status={r.status} className={r.status === "SCANNED" ? "bg-success-soft/40" : undefined}>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Code>{r.code}</Code>
                      {r.message && r.status !== "SCANNED" && <div className="mt-0.5 max-w-xs whitespace-normal text-xs text-danger">{r.message}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{r.label ?? (r.kind === "LOT" ? "Lot" : "Pack")}</td>
                    {hasGroups && <td className="whitespace-nowrap px-3 py-2 text-xs">{r.group ?? "—"}</td>}
                    <td className="px-3 py-2">
                      <ChecklistStatusBadge status={r.status} />
                    </td>
                    {rowAction && <td className="whitespace-nowrap px-3 py-2 text-right">{rowAction(r.code)}</td>}
                  </tr>
                ))}
                {view.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-sm text-muted-foreground">
                      No codes match
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {view.pages > 1 && (
            <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Checklist pages">
              <Button variant="secondary" className="min-h-9 px-3 py-1" disabled={view.page === 0} onClick={() => setPage(view.page - 1)}>
                Previous
              </Button>
              <span className="tabular text-muted-foreground">
                Page {view.page + 1} of {view.pages} · {shown.length} code{shown.length === 1 ? "" : "s"}
              </span>
              <Button variant="secondary" className="min-h-9 px-3 py-1" disabled={view.page >= view.pages - 1} onClick={() => setPage(view.page + 1)}>
                Next
              </Button>
            </nav>
          )}
        </>
      )}

      {state.strays.length > 0 && (
        <details className="rounded-control border border-danger-line bg-danger-soft/50 px-3 py-2 text-sm" data-testid="checklist-strays">
          <summary className="cursor-pointer font-semibold text-danger">
            {state.strays.length} refused scan{state.strays.length === 1 ? "" : "s"} not on this list
          </summary>
          <ul className="mt-2 space-y-1">
            {state.strays.slice(0, 50).map((s) => (
              <li key={s.code} className="flex flex-wrap items-center gap-2">
                <Code>{s.code}</Code>
                <ChecklistStatusBadge status={s.status} />
                <span className="text-xs">{s.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Counter({ label, value, name, tone }: { label: string; value: number; name: string; tone?: "ok" | "bad" }) {
  return (
    <div className="rounded-control border border-line bg-surface-2 px-2 py-1.5">
      <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className={cx("text-lg font-bold tabular", tone === "ok" && "text-success", tone === "bad" && "text-danger")} data-count={name}>
        {value}
      </dd>
    </div>
  );
}
