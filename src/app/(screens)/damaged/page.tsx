"use client";

import { useState } from "react";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { Button, Card, Code, Empty, Field, fmtTime, Input, Notice, PageTitle, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

interface DamagedItem {
  code: string;
  kind: "LOT" | "PACK";
  lotType: "CASE" | "TRAY";
  opened: boolean;
  packs: number;
  flavour: string;
  batchCode: string;
  reason: string | null;
  reportedAt: string | null;
  reportedBy: string | null;
}

const QUICK_REASONS = ["Crushed / dented", "Leaking", "Torn or wet packaging", "Broken cans"];

let seq = 0;

export default function DamagedPage() {
  const list = useApi<{ counts: { cases: number; trays: number; packs: number }; items: DamagedItem[] }>("/api/damaged", { refreshOnChange: true });
  const [reason, setReason] = useState("");
  const [log, setLog] = useState<ScanLogEntry[]>([]);

  async function onScan(code: string) {
    let ok = false;
    let message: string;
    try {
      const r = await api<{ ok: boolean; code?: string; message: string }>("/api/damaged", { body: { code, reason } });
      ok = r.ok;
      message = r.ok ? r.message : `${r.code}: ${r.message}`;
    } catch (e) {
      message = errorText(e);
    }
    setLog((l) => [{ id: ++seq, code, ok, message, at: new Date().toISOString() }, ...l].slice(0, 30));
    if (ok) {
      notifyDataChanged();
      list.reload();
    }
  }

  const items = list.data?.items ?? [];
  const counts = list.data?.counts ?? { cases: 0, trays: 0, packs: 0 };
  return (
    <>
      <PageTitle
        title="Damaged"
        subtitle="Report a damaged case, tray or pack held here. It leaves your stock, can no longer move, and Velza HQ is alerted."
      />
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card title="Report damage">
          <Field label="1. What is wrong?" hint="Kept for every code you scan until you change it">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Crushed in transit" maxLength={300} />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            {QUICK_REASONS.map((r) => (
              <Button key={r} variant="secondary" className="min-h-8 px-3 py-1 text-xs" onClick={() => setReason(r)}>
                {r}
              </Button>
            ))}
          </div>
          <div className="mt-4">
            {!reason.trim() && <Notice tone="info" className="mb-2">Say what is wrong first, then scan.</Notice>}
            <ScanInput label="2. Scan the damaged case, tray or pack" onScan={onScan} demoScreen="damage" disabled={!reason.trim()} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Scan the lot code to report a whole case or tray, sealed or opened (an opened one takes the packs of it still here).
            Single packs can be reported once the lot is opened.
          </p>
          <div className="mt-4">
            <ScanLog entries={log} />
          </div>
        </Card>
        <Card title={`Damaged here (${items.length})`}>
          {list.error && <Notice tone="error">{list.error}</Notice>}
          <div className="mb-3 grid grid-cols-3 gap-2 text-center" data-testid="damaged-counts">
            {(
              [
                ["Cases", counts.cases],
                ["Trays", counts.trays],
                ["Single packs", counts.packs],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-control border border-line bg-surface-2 px-2 py-2">
                <div className={n ? "text-xl font-semibold text-danger" : "text-xl font-semibold text-subtle-foreground"}>{n}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
          <Table head={["Code", "What", "Reason", "Reported"]} empty={items.length ? null : <Empty>Nothing reported damaged</Empty>}>
            {items.map((d) => (
              <tr key={d.code} data-testid="damaged-row">
                <Td>
                  <Code>{d.code}</Code>
                </Td>
                <Td className="text-xs">
                  {d.kind === "LOT" ? (d.lotType === "CASE" ? "Case" : "Tray") : "Pack"} · {d.flavour}
                  {d.kind === "LOT" && <div className="text-muted-foreground">{d.opened ? `Opened · ${d.packs} packs` : "Sealed"}</div>}
                  <div className="text-muted-foreground">Batch {d.batchCode}</div>
                </Td>
                <Td>{d.reason ?? "—"}</Td>
                <Td className="whitespace-nowrap text-xs text-muted-foreground">
                  {fmtTime(d.reportedAt)}
                  {d.reportedBy && <div>{d.reportedBy}</div>}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
