"use client";

import Link from "next/link";
import { useEffect } from "react";
import { IconArrowRight, IconBell, IconClipboardList, IconDatabase, IconPackage, IconPackageOpen, IconRefresh, IconRotateCcw, IconTriangleAlert, IconTruck, IconWarehouse } from "@/components/icons";
import { BarChart, DonutChart, MeterList } from "@/components/charts";
import { Reveal, RevealItem } from "@/components/motion";
import { Button, Card, Code, cx, Empty, fmtTime, LoadingPage, Notice, PageTitle, Pill, Skeleton, Stat, StatusBadge, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { ITEM_STATUSES } from "@/lib/core/types";

interface Dashboard {
  lotCounts: Record<string, number>;
  packCounts: Record<string, number>;
  totals: { lots: number; packs: number; batches: number; unsyncedLots: number };
  stock: { partnerId: string; partner: string; tier: string; tierLabel: string; cases: number; trays: number; openedCases: number; openedTrays: number; loosePacks: number; damaged: DamagedCounts; recalled?: DamagedCounts; awaitingPrint?: number; awaitingQc?: number; quarantined?: number }[];
  inTransit: { kind: string; code: string; from: string; to: string; dispatchedAt: string; age: string; overdue: boolean }[];
  alertCounts: Record<string, number>;
  recentAlerts: { id: string; type: string; at: string; code: string; message: string; partner: string | null }[];
  threshold: { label: string; demoMode: boolean };
}

/** Donut colours by status: the supply chain in Velza reds, delivered in green, moving or held in amber, out of use in greys. */
const STATUS_COLORS: Record<string, string> = {
  GENERATED: "#71717a",
  PRINTED: "#e62117",
  PACKED: "#b3141c",
  AT_WAREHOUSE: "#8a0f16",
  AT_SS: "#ff5249",
  AT_DB: "#ff8a80",
  AT_RETAILER: "#22c55e",
  OPENED: "#86efac",
  IN_TRANSIT: "#f59e0b",
  AT_CUSTOMS: "#fbbf24",
  QUARANTINED: "#d97706",
  RETURN_IN_TRANSIT: "#fcd34d",
  RETURNED: "#a1a1aa",
  VOID: "#3f3f46",
  DAMAGED: "#ef4444",
  EXPIRED: "#7f1d1d",
  RECALLED: "#c026d3",
};

const ALERT_TYPES = ["NOT_RECEIVED", "WRONG_RECEIVER", "UNKNOWN_CODE", "DUPLICATE_RECEIPT", "BLOCKED_CODE", "DAMAGED", "SUSPECT_CLONE", "PUBLIC_UNKNOWN", "PUBLIC_BLOCKED"];

/** "NOT_RECEIVED" → "Not received" (display only; the values themselves are unchanged). */
const humanize = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");

/** The 16px / 24px gutters of the Stitch layout; ROW adds the same space below each row. */
const GRID = "grid gap-4 lg:gap-6";
const ROW = cx(GRID, "mb-4 lg:mb-6");
/** KPI shelf: 2 columns on phones (the 5th tile full width), 3 + 2 tiles on tablets (6-column grid), 5 from xl. */
const KPI_GRID = "grid-cols-2 md:grid-cols-6 xl:grid-cols-5";
const KPI_SPAN = ["md:col-span-2 xl:col-span-1", "md:col-span-2 xl:col-span-1", "md:col-span-2 xl:col-span-1", "md:col-span-3 xl:col-span-1", "col-span-2 md:col-span-3 xl:col-span-1"];
/** Bar chart and donut: stacked below lg, 7 + 5 on small desktops, 8 + 4 from xl (as in Stitch). */
const CHART_SPAN = ["lg:col-span-7 xl:col-span-8", "lg:col-span-5 xl:col-span-4"];

export default function DashboardPage() {
  const { data: d, error, reload, refreshing } = useApi<Dashboard>("/api/dashboard", { refreshOnChange: true });

  useEffect(() => {
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!d) return <DashboardSkeleton />;

  const alertTotal = Object.values(d.alertCounts).reduce((a, b) => a + b, 0);
  const presentStatuses = ITEM_STATUSES.filter((s) => d.lotCounts[s] || d.packCounts[s]);
  const lotBars = presentStatuses.map((s) => ({ label: humanize(s), value: d.lotCounts[s] ?? 0 }));
  const packMix = presentStatuses.filter((s) => d.packCounts[s]).map((s) => ({ label: humanize(s), value: d.packCounts[s] ?? 0, color: STATUS_COLORS[s] ?? "#a1a1aa" }));
  const alertMeters = ALERT_TYPES.map((t) => ({ label: humanize(t), value: d.alertCounts[t] ?? 0 })).sort((a, b) => b.value - a.value);
  return (
    <>
      <PageTitle
        eyebrow="Velza HQ"
        title="HQ dashboard"
        subtitle={`Synced data only. “Not received” alerts after ${d.threshold.label}${d.threshold.demoMode ? " (demo mode)" : ""}. Refreshes every 15 s.`}
        actions={
          <Button variant="primary" onClick={reload} loading={refreshing}>
            {!refreshing && <IconRefresh size={17} />}
            Refresh
          </Button>
        }
      />

      {/* KPI shelf: 2 columns on phones (Alerts full width), 3 + 2 on tablets, 5 on desktops. */}
      <Reveal className={cx(ROW, KPI_GRID)}>
        <RevealItem className={KPI_SPAN[0]}>
          <Stat label="Batches" value={d.totals.batches} icon={IconPackage} />
        </RevealItem>
        <RevealItem className={KPI_SPAN[1]}>
          <Stat label="Lots" value={d.totals.lots} icon={IconDatabase} />
        </RevealItem>
        <RevealItem className={KPI_SPAN[2]}>
          <Stat label="Packs" value={d.totals.packs} icon={IconPackageOpen} />
        </RevealItem>
        <RevealItem className={KPI_SPAN[3]}>
          <Stat label="In transit" value={d.inTransit.length} icon={IconTruck} tone={d.inTransit.some((t) => t.overdue) ? "warn" : undefined} />
        </RevealItem>
        <RevealItem className={KPI_SPAN[4]}>
          <Stat label="Alerts" value={alertTotal} icon={IconBell} tone={alertTotal ? "danger" : "ok"} hint={alertTotal ? undefined : "All clear"} />
        </RevealItem>
      </Reveal>

      <Reveal className={cx(ROW, "lg:grid-cols-12")}>
        <RevealItem className={cx("min-w-0", CHART_SPAN[0])}>
          <Card
            title="Lots by status"
            icon={IconClipboardList}
            className="h-full"
            actions={<span className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs font-medium text-muted-foreground tabular">Total: {d.totals.lots.toLocaleString()}</span>}
          >
            {lotBars.length ? <BarChart data={lotBars} label="Lots by status" /> : <Empty>No lots yet</Empty>}
          </Card>
        </RevealItem>
        <RevealItem className={cx("min-w-0", CHART_SPAN[1])}>
          <Card title="Pack status mix" icon={IconPackageOpen} className="h-full">
            {packMix.length ? <DonutChart data={packMix} label="Packs by status" centerLabel="Packs" /> : <Empty>No packs yet</Empty>}
          </Card>
        </RevealItem>
      </Reveal>

      <Reveal className={cx(ROW, "md:grid-cols-2 xl:grid-cols-3")}>
        <RevealItem className="min-w-0">
          <Card
            title="Recent alerts"
            icon={IconBell}
            className="h-full"
            actions={
              <Link href="/hq/alerts" className="group inline-flex items-center gap-1 rounded-control text-xs font-semibold text-muted-foreground transition-colors duration-150 hover:text-brand">
                All alerts
                <IconArrowRight size={14} className="transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
            }
          >
            {d.recentAlerts.length ? (
              <ul className="divide-y divide-line text-sm">
                {d.recentAlerts.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 py-2.5 first:pt-0">
                    <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger">
                      <IconTriangleAlert size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8125rem] text-foreground">{a.message}</span>
                      <span className="mt-0.5 block text-xs font-semibold text-danger">{humanize(a.type)}</span>
                    </span>
                    <span className="whitespace-nowrap font-mono text-[0.6875rem] text-muted-foreground tabular">{fmtTime(a.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-xl border border-dashed border-line-strong bg-surface-2/60">
                <Empty>No alerts</Empty>
              </div>
            )}
          </Card>
        </RevealItem>
        <RevealItem className="min-w-0">
          <Card title="Alerts by type" icon={IconTriangleAlert} className="h-full">
            <MeterList data={alertMeters} label="Alerts by type" />
          </Card>
        </RevealItem>
        <RevealItem className="min-w-0 md:col-span-2 xl:col-span-1">
          <Card title="Counts by status" icon={IconClipboardList} className="flex h-full flex-col">
            <Table head={["Status", "Lots", "Packs"]} align={["left", "right", "right"]}>
              {presentStatuses.map((s) => (
                <tr key={s}>
                  <Td>
                    <StatusBadge status={s} />
                  </Td>
                  <Td className="text-right font-mono">{(d.lotCounts[s] ?? 0).toLocaleString()}</Td>
                  <Td className="text-right font-mono">{(d.packCounts[s] ?? 0).toLocaleString()}</Td>
                </tr>
              ))}
            </Table>
            <p className="mt-4 rounded-xl border border-line bg-surface-2 p-3 text-[0.6875rem] leading-relaxed text-muted-foreground xl:mt-auto">
              Cases and trays include opened ones; loose packs are the packs of opened cases and trays still there. Stock by location counts released stock only: recalled, damaged, quarantined and not-yet-verified units are shown apart.
            </p>
          </Card>
        </RevealItem>
      </Reveal>

      <div className={cx(ROW, "animate-rise-in")}>
        <Card title="Stock by location" icon={IconWarehouse} className="min-w-0">
          <Table
            head={["Tier", "Partner", "Cases", "Trays", "Loose packs", "Damaged", "Recalled"]}
            align={["left", "left", "right", "right", "right", "right", "right"]}
            empty={d.stock.length ? null : <Empty>No stock</Empty>}
          >
            {d.stock.map((s) => (
              <tr key={s.partnerId}>
                <Td className="whitespace-nowrap text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-foreground-2">{s.tierLabel}</Td>
                <Td className="font-medium">{s.partner}</Td>
                <Td className="text-right font-mono">
                  <Opened total={s.cases} opened={s.openedCases} />
                  {!!s.awaitingPrint && <div className="whitespace-nowrap font-sans text-xs text-muted-foreground">{s.awaitingPrint} lot(s) not printed yet</div>}
                  {!!s.awaitingQc && <div className="whitespace-nowrap font-sans text-xs text-muted-foreground">{s.awaitingQc} lot(s) awaiting QC</div>}
                  {!!s.quarantined && <div className="whitespace-nowrap font-sans text-xs text-warning">{s.quarantined} lot(s) quarantined</div>}
                </Td>
                <Td className="text-right font-mono">
                  <Opened total={s.trays} opened={s.openedTrays} />
                </Td>
                <Td className="text-right font-mono">{s.loosePacks}</Td>
                <Td className="whitespace-nowrap text-right text-xs">
                  <DamagedSummary counts={s.damaged} />
                </Td>
                <Td className="whitespace-nowrap text-right text-xs">
                  <DamagedSummary counts={s.recalled ?? { cases: 0, trays: 0, packs: 0 }} />
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <div className={cx(GRID, "animate-rise-in lg:grid-cols-3")}>
        <Card title={`In transit (${d.inTransit.length})`} icon={IconTruck} className="min-w-0">
          <Table head={["Code", "From → To", "Age"]} align={["left", "left", "right"]} empty={d.inTransit.length ? null : <Empty>Nothing in transit</Empty>}>
            {d.inTransit.map((t) => (
              <tr key={t.code} className={t.overdue ? "bg-warning-soft" : ""}>
                <Td>
                  <Link href={`/hq/search?code=${t.code}`} className="underline-offset-4 hover:underline">
                    <Code>{t.code}</Code>
                  </Link>
                </Td>
                <Td className="text-xs">
                  {t.from} → {t.to}
                </Td>
                <Td className={t.overdue ? "whitespace-nowrap text-right font-semibold text-warning" : "whitespace-nowrap text-right"}>
                  <span className="inline-flex items-center gap-1">
                    {t.age}
                    {t.overdue && <IconTriangleAlert size={16} aria-label="Overdue" aria-hidden={false} role="img" />}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <ReturnsReport />
      </div>
    </>
  );
}

interface ReturnRow {
  id: string;
  code: string;
  item: string;
  flavour: string;
  batch: string;
  expiry: string | null;
  returnedFrom: string | null;
  returnedFromTier: string | null;
  reason: string | null;
  pickedUpBy: string | null;
  date: string;
  decision: string;
}

/** Stock Velza field staff took back from partners, and what the Velza Warehouse decided after inspecting it. */
function ReturnsReport() {
  const { data, error } = useApi<{ rows: ReturnRow[] }>("/api/returns/report", { refreshOnChange: true });
  const rows = data?.rows ?? [];
  // Empty text only once the report has loaded; skeleton rows while it loads; the hook's error if it failed.
  const empty = rows.length ? null : error ? (
    <div className="p-3">
      <Notice tone="error">{error}</Notice>
    </div>
  ) : data ? (
    <Empty>Nothing has been taken back</Empty>
  ) : (
    <div className="space-y-3 p-4" role="status">
      <span className="sr-only">Loading returns…</span>
      <Skeleton className="h-5" />
      <Skeleton className="h-5 w-11/12" />
      <Skeleton className="h-5 w-10/12" />
    </div>
  );
  return (
    <Card title={`Returns (${rows.length})`} icon={IconRotateCcw} className="min-w-0 lg:col-span-2">
      <Table head={["Code", "Item", "Flavour", "Batch", "Expiry", "Returned from", "Reason", "Picked up by", "Date", "Final decision"]} empty={empty}>
        {rows.map((r) => (
          <tr key={r.id} data-testid="returns-row" data-code={r.code}>
            <Td>
              <Link href={`/hq/search?code=${r.code}`} className="underline-offset-4 hover:underline">
                <Code>{r.code}</Code>
              </Link>
            </Td>
            <Td>{r.item}</Td>
            <Td>{r.flavour}</Td>
            <Td>
              <Code>{r.batch}</Code>
            </Td>
            <Td className="whitespace-nowrap">{r.expiry ?? "—"}</Td>
            <Td>
              {r.returnedFrom ?? "—"}
              {r.returnedFromTier && <div className="text-xs text-muted-foreground">{r.returnedFromTier}</div>}
            </Td>
            <Td>{r.reason ?? "—"}</Td>
            <Td>{r.pickedUpBy ?? "—"}</Td>
            <Td className="whitespace-nowrap">{fmtTime(r.date)}</Td>
            <Td>
              <Pill tone={r.decision.startsWith("Written off") ? "danger" : r.decision === "Back to stock" ? "ok" : "warn"}>{r.decision}</Pill>
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

interface DamagedCounts {
  cases: number;
  trays: number;
  packs: number;
}

/** Damaged cases and trays (opened or not) and single packs, e.g. "2 cases · 1 tray". */
function DamagedSummary({ counts }: { counts: DamagedCounts }) {
  const parts = [
    [counts.cases, "case"],
    [counts.trays, "tray"],
    [counts.packs, "pack"],
  ]
    .filter(([n]) => n)
    .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  return parts.length ? <span className="font-semibold text-danger">{parts.join(" · ")}</span> : <span className="text-subtle-foreground">0</span>;
}

/** A case or tray count, with how many of them are opened. */
function Opened({ total, opened }: { total: number; opened: number }) {
  return (
    <>
      {total}
      {opened > 0 && <div className="whitespace-nowrap text-xs text-muted-foreground">{opened} opened</div>}
    </>
  );
}

/** Same grid as the loaded dashboard (title, 5 stat tiles, 4 cards), so nothing jumps when the data arrives. */
function DashboardSkeleton() {
  return (
    <LoadingPage
      title="HQ dashboard"
      subtitle
      actions={
        <Button variant="primary" disabled>
          <IconRefresh size={17} />
          Refresh
        </Button>
      }
    >
      <div className={cx(ROW, KPI_GRID)}>
        {["Batches", "Lots", "Packs", "In transit", "Alerts"].map((label, i) => (
          <div key={label} className={cx("rounded-card border border-line bg-surface p-4 shadow-card sm:p-5", KPI_SPAN[i])}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">{label}</span>
              <Skeleton className="h-8 w-8 rounded-icon" />
            </div>
            <Skeleton className="mt-4 h-9 w-20" />
          </div>
        ))}
      </div>
      <div className={cx(ROW, "lg:grid-cols-12")}>
        <Card title="Lots by status" className={CHART_SPAN[0]}>
          <Skeleton className="h-[256px]" />
        </Card>
        <Card title="Pack status mix" className={CHART_SPAN[1]}>
          <div className="flex flex-col items-center gap-6">
            <Skeleton className="h-44 w-44 shrink-0 rounded-full" />
            <div className="w-full space-y-3">
              <Skeleton className="h-4" />
              <Skeleton className="h-4 w-10/12" />
            </div>
          </div>
        </Card>
      </div>
      <div className={cx(GRID, "md:grid-cols-2 xl:grid-cols-3")}>
        {["Recent alerts", "Alerts by type", "Counts by status"].map((title, i) => (
          <Card key={title} title={title} className={i === 2 ? "md:col-span-2 xl:col-span-1" : undefined}>
            <div className="space-y-3">
              <Skeleton className="h-9" />
              <Skeleton className="h-6 w-11/12" />
              <Skeleton className="h-6 w-10/12" />
              <Skeleton className="h-6 w-9/12" />
            </div>
          </Card>
        ))}
      </div>
    </LoadingPage>
  );
}
