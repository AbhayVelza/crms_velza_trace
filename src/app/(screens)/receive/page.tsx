"use client";

// Receive (scan IN): each scan is committed immediately by the server (as before) and shows green/red with the reason.
// The checklist lists everything in transit to you, with the invoice it was dispatched on; a row is ticked only when
// the server has received it. Received rows stay ticked while you are on the page.

import { useEffect, useState } from "react";
import { ScanChecklist, useChecklist } from "@/components/ScanChecklist";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import type { StockItem } from "@/components/StockTable";
import { useSession } from "@/components/session";
import { Card, PageTitle } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { applyAccepted, applyRejected, rebaseChecklist, type ChecklistItem } from "@/lib/scan/checklist";
import { notifyDataChanged } from "@/lib/events";

let seq = 0;

export default function ReceivePage() {
  const { partner } = useSession();
  // The Velza Warehouse also receives a whole shipping container by scanning its number.
  const warehouse = partner?.type === "WAREHOUSE";
  const stock = useApi<{ incoming: StockItem[] }>("/api/stock", { refreshOnChange: true });
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const checklist = useChecklist();
  const updateChecklist = checklist.update; // stable: safe as an effect dependency

  useEffect(() => {
    if (!stock.data) return;
    const expected: ChecklistItem[] = stock.data.incoming.map((i) => ({
      code: i.code,
      kind: i.kind,
      label: `${i.kind === "PACK" ? "Pack" : i.lotType === "CASE" ? "Case" : "Tray"} · ${i.flavour} · from ${i.from ?? "?"}`,
      group: i.invoice ?? null,
    }));
    updateChecklist((s) => rebaseChecklist(s, expected, (r) => r.status === "SCANNED"));
  }, [stock.data, updateChecklist]);

  async function onScan(code: string) {
    let entry: Omit<ScanLogEntry, "id" | "at">;
    try {
      const r = await api<{ ok: boolean; code?: string; message: string }>("/api/receive", { body: { code } });
      entry = { code, ok: r.ok, message: r.ok ? r.message : `${r.code}: ${r.message}` };
      updateChecklist((s) => (r.ok ? applyAccepted(s, code, r.message) : applyRejected(s, code, r.code, r.message)));
    } catch (e) {
      // Not known whether it was received: nothing is ticked; scanning again is safe (a second receipt is refused).
      entry = { code, ok: false, message: `Not confirmed: ${errorText(e)} — scan it again` };
    }
    setLog((l) => [{ ...entry, id: ++seq, at: new Date().toISOString() }, ...l].slice(0, 50));
    notifyDataChanged();
  }

  return (
    <>
      <PageTitle title="Receive (scan IN)" subtitle={`Scan lots or packs arriving at ${partner?.name ?? "your location"}, one after another.${warehouse ? " Scan a container's number to receive everything in it at once." : ""}`} />
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card>
          <ScanInput label={warehouse ? "Code or container number" : "Code"} onScan={onScan} demoScreen="receive" validate={!warehouse} />
          <div className="mt-4">
            <ScanLog entries={log} />
          </div>
        </Card>
        <Card title={`Expected (in transit to you): ${stock.data?.incoming.length ?? 0}`}>
          <ScanChecklist
            state={checklist.state}
            title="Expected deliveries"
            groupLabel="Invoice"
            emptyText={stock.data ? "Nothing is in transit to you" : "Loading…"}
            completeText="Everything that was on its way to you has been received."
          />
        </Card>
      </div>
    </>
  );
}
