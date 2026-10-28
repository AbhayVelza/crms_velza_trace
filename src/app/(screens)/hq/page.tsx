"use client";

import Link from "next/link";
import { useEffect } from "react";
import { IconArrowRight, IconRefresh, IconTriangleAlert } from "@/components/icons";
import { Button, Card, Code, Empty, fmtTime, Loading, Notice, PageTitle, Pill, Stat, StatusBadge, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { ITEM_STATUSES } from "@/lib/core/types";

interface Dashboard {
  lotCounts: Record<string, number>;
  packCounts: Record<string, number>;
  totals: { lots: number; packs: number; batches: number; unsyncedLots: number };
  stock: { partnerId: string; partner: string; tier: string; tierLabel: string; cases: number; trays: number; openedCases: number; openedTrays: number; loosePacks: number; damaged: DamagedCounts }[];
  inTransit: { kind: string; code: string; from: string; to: string; dispatchedAt: string; age: string; overdue: boolean }[];
  alertCounts: Record<string, number>;
  recentAlerts: { id: string; type: string; at: string; code: string; message: string; partner: string | null }[];
  threshold: { label: string; demoMode: boolean };
}

const ALERT_TYPES = ["NOT_RECEIVED", "WRONG_RECEIVER", "UNKNOWN_CODE", "DUPLICATE_RECEIPT", "BLOCKED_CODE", "DAMAGED"];

export default function DashboardPage() {
  const { data: d, error, reload } = useApi<Dashboard>("/api/dashboard", { refreshOnChange: true });

  useEffect(() => {
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!d) return <Loading />;

  const alertTotal = Object.values(d.alertCounts).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageTitle
        title="HQ dashboard"
        subtitle={`Synced data only. NOT_RECEIVED after ${d.threshold.label}${d.threshold.demoMode ? " (demo mode)" : ""}. Refreshes every 15 s.`}
        actions={
          <Button variant="secondary" onClick={reload}>
            <IconRefresh size={17} />
            Refresh
          </Button>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-5 lg:mb-5 lg:gap-5">
        <Stat label="Batches" value={d.totals.batches} />
        <Stat label="Lots" value={d.totals.lots} />
        <Stat label="Packs" value={d.totals.packs} />
        <Stat label="In transit" value={d.inTransit.length} tone={d.inTransit.some((t) => t.overdue) ? "warn" : undefined} />
        <Stat label="Alerts" value={alertTotal} tone={alertTotal ? "danger" : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card title="Counts by status">
          <Table head={["Status", "Lots", "Packs"]}>
            {ITEM_STATUSES.filter((s) => d.lotCounts[s] || d.packCounts[s]).map((s) => (
              <tr key={s}>
                <Td>
                  <StatusBadge status={s} />
                </Td>
                <Td>{d.lotCounts[s] ?? 0}</Td>
                <Td>{d.packCounts[s] ?? 0}</Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">Cases and trays include opened ones; loose packs are the packs of opened cases and trays still there.</p>
        </Card>

        <Card
          title="Alerts"
          actions={
            <Link href="/hq/alerts" className="group inline-flex items-center gap-1 text-sm font-semibold text-foreground underline-offset-4 hover:underline">
              All alerts
              <IconArrowRight size={16} className="transition-transform duration-150 group-hover:translate-x-0.5" />
            </Link>
          }
        >
          <div className="mb-3 flex flex-wrap gap-2">
            {ALERT_TYPES.map((t) => (
              <Pill key={t} tone={d.alertCounts[t] ? "danger" : "muted"} dot={!!d.alertCounts[t]}>
                {t.replace(/_/g, " ")}: {d.alertCounts[t] ?? 0}
              </Pill>
            ))}
          </div>
          {d.recentAlerts.length ? (
            <ul className="divide-y divide-line text-sm">
              {d.recentAlerts.map((a) => (
                <li key={a.id} className="flex items-baseline gap-2 py-1.5">
                  <span className="whitespace-nowrap text-xs text-muted-foreground tabular">{fmtTime(a.at)}</span>
                  <span className="whitespace-nowrap text-xs font-bold tracking-wide text-danger">{a.type}</span>
                  <span className="truncate text-foreground">{a.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No alerts</Empty>
          )}
        </Card>

        <Card title="Stock by location">
          <Table head={["Tier", "Partner", "Cases", "Trays", "Loose packs", "Damaged"]} empty={d.stock.length ? null : <Empty>No stock</Empty>}>
            {d.stock.map((s) => (
              <tr key={s.partnerId}>
                <Td className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.tierLabel}</Td>
                <Td>{s.partner}</Td>
                <Td>
                  <Opened total={s.cases} opened={s.openedCases} />
                </Td>
                <Td>
                  <Opened total={s.trays} opened={s.openedTrays} />
                </Td>
                <Td>{s.loosePacks}</Td>
                <Td className="whitespace-nowrap text-xs">
                  <DamagedSummary counts={s.damaged} />
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title={`In transit (${d.inTransit.length})`}>
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
    </>
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
