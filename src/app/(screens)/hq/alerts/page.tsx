"use client";

import Link from "next/link";
import { useState } from "react";
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

const TYPES = ["NOT_RECEIVED", "WRONG_RECEIVER", "UNKNOWN_CODE", "DUPLICATE_RECEIPT", "BLOCKED_CODE"];

export default function AlertsPage() {
  const { data, error } = useApi<AlertRow[]>("/api/alerts", { refreshOnChange: true });
  const [filter, setFilter] = useState<string | null>(null);
  const rows = (data ?? []).filter((a) => !filter || a.type === filter);
  return (
    <>
      <PageTitle title="Alerts" subtitle="Computed from the scan audit log and items in transit." />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => setFilter(null)} className={cx("rounded-full px-3 py-1 text-sm", !filter ? "bg-teal-700 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300")}>
          All ({data?.length ?? 0})
        </button>
        {TYPES.map((t) => (
          <button key={t} type="button" onClick={() => setFilter(t)} className={cx("rounded-full px-3 py-1 text-sm", filter === t ? "bg-teal-700 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300")}>
            {t.replace(/_/g, " ")} ({data?.filter((a) => a.type === t).length ?? 0})
          </button>
        ))}
      </div>
      <Card>
        <Table head={["Time", "Type", "Code", "Message", "Where / who"]} empty={rows.length ? null : <Empty>No alerts</Empty>}>
          {rows.map((a) => (
            <tr key={a.id} data-testid="alert-row">
              <Td className="whitespace-nowrap">{fmtTime(a.at)}</Td>
              <Td className="whitespace-nowrap font-semibold text-red-800">{a.type}</Td>
              <Td>
                <Link href={`/hq/search?code=${encodeURIComponent(a.code)}`} className="hover:underline">
                  <Code>{a.code}</Code>
                </Link>
              </Td>
              <Td>{a.message}</Td>
              <Td className="text-xs text-slate-600">
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
