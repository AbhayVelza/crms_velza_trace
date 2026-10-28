"use client";

import Link from "next/link";
import { useState } from "react";
import { IconTriangleAlert } from "@/components/icons";
import { Card, Code, cx, Empty, fmtTime, Notice, PageTitle, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";

interface AlertRow {
  id: string;
  type: string;
  at: string;
  code: string;
  message: string;
  partner: string | null;
  user: string | null;
}

const CHIP = "inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors duration-150";
const CHIP_ON = "border-primary bg-primary text-primary-foreground";
const CHIP_OFF = "border-line-strong bg-surface text-foreground-2 hover:border-foreground/40 hover:bg-muted";

const TYPES = ["NOT_RECEIVED", "WRONG_RECEIVER", "UNKNOWN_CODE", "DUPLICATE_RECEIPT", "BLOCKED_CODE", "DAMAGED"];

export default function AlertsPage() {
  const { data, error } = useApi<AlertRow[]>("/api/alerts", { refreshOnChange: true });
  const [filter, setFilter] = useState<string | null>(null);
  const rows = (data ?? []).filter((a) => !filter || a.type === filter);
  return (
    <>
      <PageTitle title="Alerts" subtitle="Computed from the scan audit log, damage reports and items in transit." />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by type">
        <button type="button" aria-pressed={!filter} onClick={() => setFilter(null)} className={cx(CHIP, !filter ? CHIP_ON : CHIP_OFF)}>
          All ({data?.length ?? 0})
        </button>
        {TYPES.map((t) => (
          <button key={t} type="button" aria-pressed={filter === t} onClick={() => setFilter(t)} className={cx(CHIP, filter === t ? CHIP_ON : CHIP_OFF)}>
            {t.replace(/_/g, " ")} ({data?.filter((a) => a.type === t).length ?? 0})
          </button>
        ))}
      </div>
      <Card>
        <Table head={["Time", "Type", "Code", "Message", "Where / who"]} empty={rows.length ? null : <Empty>No alerts</Empty>}>
          {rows.map((a) => (
            <tr key={a.id} data-testid="alert-row">
              <Td className="whitespace-nowrap text-muted-foreground">{fmtTime(a.at)}</Td>
              <Td className="whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold tracking-wide text-danger">
                  <IconTriangleAlert size={16} />
                  {a.type}
                </span>
              </Td>
              <Td>
                <Link href={`/hq/search?code=${encodeURIComponent(a.code)}`} className="underline-offset-4 hover:underline">
                  <Code>{a.code}</Code>
                </Link>
              </Td>
              <Td>{a.message}</Td>
              <Td className="text-xs text-muted-foreground">
                {a.partner}
                {a.user && <div>{a.user}</div>}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
