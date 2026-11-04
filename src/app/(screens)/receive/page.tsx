"use client";

// Receive (scan IN): each scan is committed immediately and shows green/red with the reason.

import { useState } from "react";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { StockTable, type StockItem } from "@/components/StockTable";
import { useSession } from "@/components/session";
import { Card, PageTitle } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

let seq = 0;

export default function ReceivePage() {
  const { partner } = useSession();
  const stock = useApi<{ incoming: StockItem[] }>("/api/stock", { refreshOnChange: true });
  const [log, setLog] = useState<ScanLogEntry[]>([]);

  async function onScan(code: string) {
    let entry: Omit<ScanLogEntry, "id" | "at">;
    try {
      const r = await api<{ ok: boolean; code?: string; message: string }>("/api/receive", { body: { code } });
      entry = { code, ok: r.ok, message: r.ok ? r.message : `${r.code}: ${r.message}` };
    } catch (e) {
      entry = { code, ok: false, message: errorText(e) };
    }
    setLog((l) => [{ ...entry, id: ++seq, at: new Date().toISOString() }, ...l].slice(0, 50));
    notifyDataChanged();
  }

  return (
    <>
      <PageTitle title="Receive (scan IN)" subtitle={`Scan lots or packs arriving at ${partner?.name ?? "your location"}, one after another.`} />
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card>
          <ScanInput label="Code" onScan={onScan} demoScreen="receive" />
          <div className="mt-4">
            <ScanLog entries={log} />
          </div>
        </Card>
        <Card title={`Expected (in transit to you): ${stock.data?.incoming.length ?? 0}`}>
          <StockTable items={stock.data?.incoming ?? []} show="from" empty="Nothing is in transit to you" />
        </Card>
      </div>
    </>
  );
}
