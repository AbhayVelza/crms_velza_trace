"use client";

import Link from "next/link";
import { useEffect } from "react";
import { IconArrowRight, IconBell, IconClipboardList, IconDatabase, IconPackage, IconPackageOpen, IconRefresh, IconRotateCcw, IconTriangleAlert, IconTruck, IconWarehouse } from "@/components/icons";
import { BarChart, DonutChart, MeterList } from "@/components/charts";
import { Reveal, RevealItem } from "@/components/motion";
import { Button, Card, Code, Empty, fmtTime, LoadingPage, Notice, PageTitle, Pill, Skeleton, Stat, StatusBadge, Table, Td } from "@/components/ui";
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
  const lotBars = presentStatuses.map((s) => ({ label: s.replace(/_/g, " "), value: d.lotCounts[s] ?? 0 }));
  const packMix = presentStatuses.filter((s) => d.packCounts[s]).map((s) => ({ label: s.replace(/_/g, " "), value: d.packCounts[s] ?? 0, color: STATUS_COLORS[s] ?? "#a1a1aa" }));
  const alertMeters = ALERT_TYPES.map((t) => ({ label: t.replace(/_/g, " "), value: d.alertCounts[t] ?? 0 })).sort((a, b) => b.value - a.value);
  return (
    <>
      <PageTitle
        eyebrow="Velza HQ"
        title="HQ dashboard"
        subtitle={`Synced data only. NOT_RECEIVED after ${d.threshold.label}${d.threshold.demoMode ? " (demo mode)" : ""}. Refreshes every 15 s.`}
        actions={
          <Button variant="primary" onClick={reload} loading={refreshing}>
            {!refreshing && <IconRefresh size={17} />}
            Refresh
          </Button>
        }
      />
      <Reveal className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:mb-5 lg:gap-5 xl:grid-cols-5">
        <RevealItem>
          <Stat label="Batches" value={d.totals.batches} icon={IconPackage} />
        </RevealItem>
        <RevealItem>
          <Stat label="Lots" value={d.totals.lots} icon={IconDatabase} />
        </RevealItem>
        <RevealItem>
          <Stat label="Packs" value={d.totals.packs} icon={IconPackageOpen} />
        </RevealItem>
        <RevealItem>
          <Stat label="In transit" value={d.inTransit.length} icon={IconTruck} tone={d.inTransit.some((t) => t.overdue) ? "warn" : undefined} />
        </RevealItem>
        <RevealItem className="col-span-2 md:col-span-1">
          <Stat label="Alerts" value={alertTotal} icon={IconBell} tone={alertTotal ? "danger" : undefined} />
        </RevealItem>
      </Reveal>

      <Reveal className="mb-4 grid gap-4 lg:mb-5 lg:grid-cols-3 lg:gap-5">
        <RevealItem className="min-w-0 lg:col-span-2">
          <Card title="Lots by status" icon={IconClipboardList} className="h-full">
            {lotBars.length ? <BarChart data={lotBars} label="Lots by status" /> : <Empty>No lots yet</Empty>}
          </Card>
        </RevealItem>
        <RevealItem className="min-w-0">
          <Card title="Pack status mix" icon={IconPackageOpen} className="h-full">
            {packMix.length ? <DonutChart data={packMix} label="Packs by status" centerLabel="Packs" /> : <Empty>No packs yet</Empty>}
          </Card>
        </RevealItem>
      </Reveal>

      <Reveal className="mb-4 grid gap-4 lg:mb-5 lg:grid-cols-3 lg:gap-5">
        <RevealItem className="min-w-0">
          <Card
            title="Recent alerts"
            icon={IconBell}
            className="h-full"
            actions={
              <Link href="/hq/alerts" className="group inline-flex items-center gap-1 rounded-control text-sm font-semibold text-brand underline-offset-4 hover:underline">
                All alerts
                <IconArrowRight size={16} className="transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
            }
          >
            {d.recentAlerts.length ? (
              <ul className="divide-y divide-line text-sm">
                {d.recentAlerts.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 py-2.5">
                    <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-danger-line bg-danger-soft text-danger">
                      <IconTriangleAlert size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{a.message}</span>
                      <span className="mt-0.5 block text-xs font-semibold tracking-wide text-danger">{a.type}</span>
                    </span>
                    <span className="whitespace-nowrap text-xs text-muted-foreground tabular">{fmtTime(a.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No alerts</Empty>
            )}
          </Card>
        </RevealItem>
        <RevealItem className="min-w-0">
          <Card title="Alerts by type" icon={IconTriangleAlert} className="h-full">
            <MeterList data={alertMeters} label="Alerts by type" />
          </Card>
        </RevealItem>
        <RevealItem className="min-w-0">
          <Card title="Counts by status" icon={IconClipboardList} className="h-full">
            <Table head={["Status", "Lots", "Packs"]}>
              {presentStatuses.map((s) => (
                <tr key={s}>
                  <Td>
                    <StatusBadge status={s} />
                  </Td>
                  <Td>{(d.lotCounts[s] ?? 0).toLocaleString()}</Td>
                  <Td>{(d.packCounts[s] ?? 0).toLocaleString()}</Td>
                </tr>
              ))}
            </Table>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Cases and trays include opened ones; loose packs are the packs of opened cases and trays still there. Stock by location counts released stock only: recalled, damaged, quarantined and not-yet-verified units are shown apart.</p>
          </Card>
        </RevealItem>
      </Reveal>

      <div className="grid animate-rise-in gap-4 lg:grid-cols-3 lg:gap-5">
        <Card title="Stock by location" icon={IconWarehouse} className="min-w-0 lg:col-span-2">
          <Table head={["Tier", "Partner", "Cases", "Trays", "Loose packs", "Damaged", "Recalled"]} empty={d.stock.length ? null : <Empty>No stock</Empty>}>
            {d.stock.map((s) => (
              <tr key={s.partnerId}>
                <Td className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.tierLabel}</Td>
                <Td>{s.partner}</Td>
                <Td>
                  <Opened total={s.cases} opened={s.openedCases} />
                  {!!s.awaitingPrint && <div className="whitespace-nowrap text-xs text-muted-foreground">{s.awaitingPrint} lot(s) not printed yet</div>}
                  {!!s.awaitingQc && <div className="whitespace-nowrap text-xs text-muted-foreground">{s.awaitingQc} lot(s) awaiting QC</div>}
                  {!!s.quarantined && <div className="whitespace-nowrap text-xs text-warning">{s.quarantined} lot(s) quarantined</div>}
                </Td>
                <Td>
                  <Opened total={s.trays} opened={s.openedTrays} />
                </Td>
                <Td>{s.loosePacks}</Td>
                <Td className="whitespace-nowrap text-xs">
                  <DamagedSummary counts={s.damaged} />
                </Td>
                <Td className="whitespace-nowrap text-xs">
                  <DamagedSummary counts={s.recalled ?? { cases: 0, trays: 0, packs: 0 }} />
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title={`In transit (${d.inTransit.length})`} icon={IconTruck} className="min-w-0">
          <Table head={["Code", "From → To", "Age"]} empty={d.inTransit.length ? null : <Empty>Nothing in transit</Empty>}>
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
                <Td className={t.overdue ? "whitespace-nowrap font-semibold text-warning" : "whitespace-nowrap"}>
                  <span className="inline-flex items-center gap-1">
                    {t.age}
                    {t.overdue && <IconTriangleAlert size={16} aria-label="Overdue" aria-hidden={false} role="img" />}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <ReturnsReport />
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
  const { data } = useApi<{ rows: ReturnRow[] }>("/api/returns/report", { refreshOnChange: true });
  const rows = data?.rows ?? [];
  return (
    <Card title={`Returns (${rows.length})`} icon={IconRotateCcw} className="mt-4 animate-rise-in lg:mt-5">
      <Table
        head={["Code", "Item", "Flavour", "Batch", "Expiry", "Returned from", "Reason", "Picked up by", "Date", "Final decision"]}
        empty={rows.length ? null : <Empty>{data ? "Nothing has been taken back" : "Loading…"}</Empty>}
      >
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
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:mb-5 lg:gap-5 xl:grid-cols-5">
        {["Batches", "Lots", "Packs", "In transit", "Alerts"].map((label, i) => (
          <div key={label} className={`card-surface rounded-card border border-line bg-surface p-4 shadow-card sm:p-5 ${i === 4 ? "col-span-2 md:col-span-1" : ""}`}>
            <div className="text-[0.8125rem] font-semibold text-foreground-2">{label}</div>
            <Skeleton className="mt-3 h-8 w-20" />
          </div>
        ))}
      </div>
      <div className="mb-4 grid gap-4 lg:mb-5 lg:grid-cols-3 lg:gap-5">
        <Card title="Lots by status" className="lg:col-span-2">
          <Skeleton className="h-[240px]" />
        </Card>
        <Card title="Pack status mix">
          <div className="flex items-center gap-5">
            <Skeleton className="h-40 w-40 shrink-0 rounded-full" />
            <div className="w-full space-y-3">
              <Skeleton className="h-4" />
              <Skeleton className="h-4 w-10/12" />
              <Skeleton className="h-4 w-9/12" />
            </div>
          </div>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
        {["Recent alerts", "Alerts by type", "Counts by status"].map((title) => (
          <Card key={title} title={title}>
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
