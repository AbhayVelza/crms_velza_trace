"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, Card, Code, Empty, fmtTime, Notice, PageTitle, Stat, StatusBadge, Table, Td } from "@/components/ui";
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
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>;

  const alertTotal = Object.values(d.alertCounts).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageTitle
        title="HQ dashboard"
        subtitle={`Synced data only. NOT_RECEIVED after ${d.threshold.label}${d.threshold.demoMode ? " (demo mode)" : ""}. Refreshes every 15 s.`}
        actions={
          <Button variant="secondary" onClick={reload}>
            Refresh
          </Button>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Batches" value={d.totals.batches} />
        <Stat label="Lots" value={d.totals.lots} />
        <Stat label="Packs" value={d.totals.packs} />
        <Stat label="In transit" value={d.inTransit.length} tone={d.inTransit.some((t) => t.overdue) ? "warn" : undefined} />
        <Stat label="Alerts" value={alertTotal} tone={alertTotal ? "danger" : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
          <p className="mt-2 text-xs text-slate-500">Cases and trays include opened ones; loose packs are the packs of opened cases and trays still there.</p>
        </Card>

        <Card title="Alerts" actions={<Link href="/hq/alerts" className="text-sm text-teal-800 hover:underline">All alerts →</Link>}>
          <div className="mb-3 flex flex-wrap gap-2">
            {ALERT_TYPES.map((t) => (
              <span key={t} className={d.alertCounts[t] ? "rounded bg-red-100 px-2 py-1 text-xs font-semibold text-red-800" : "rounded bg-slate-100 px-2 py-1 text-xs text-slate-500"}>
                {t.replace(/_/g, " ")}: {d.alertCounts[t] ?? 0}
              </span>
            ))}
          </div>
          {d.recentAlerts.length ? (
            <ul className="space-y-1 text-sm">
              {d.recentAlerts.map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className="whitespace-nowrap text-xs text-slate-500">{fmtTime(a.at)}</span>
                  <span className="font-semibold text-red-800">{a.type}</span>
                  <span className="truncate">{a.message}</span>
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
                <Td className="whitespace-nowrap text-xs text-slate-500">{s.tierLabel}</Td>
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
              <tr key={t.code} className={t.overdue ? "bg-amber-50" : ""}>
                <Td>
                  <Link href={`/hq/search?code=${t.code}`} className="hover:underline">
                    <Code>{t.code}</Code>
                  </Link>
                </Td>
                <Td className="text-xs">
                  {t.from} → {t.to}
                </Td>
                <Td className={t.overdue ? "font-semibold text-amber-800" : ""}>
                  {t.age}
                  {t.overdue && " ⚠"}
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
  return parts.length ? <span className="font-semibold text-red-800">{parts.join(" · ")}</span> : <span className="text-slate-400">0</span>;
}

/** A case or tray count, with how many of them are opened. */
function Opened({ total, opened }: { total: number; opened: number }) {
  return (
    <>
      {total}
      {opened > 0 && <div className="whitespace-nowrap text-xs text-slate-500">{opened} opened</div>}
    </>
  );
}
