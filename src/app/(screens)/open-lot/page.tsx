"use client";

import { useState } from "react";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { Card, Code, PageTitle, StatusBadge } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

let seq = 0;

export default function OpenLotPage() {
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [packs, setPacks] = useState<{ packCode: string; status: string }[]>([]);

  async function onScan(lotCode: string) {
    let ok = false;
    let message: string;
    try {
      const r = await api<{ ok: boolean; code?: string; message: string; packs?: { packCode: string; status: string }[] }>("/api/open-lot", { body: { lotCode } });
      ok = r.ok;
      message = r.ok ? r.message : `${r.code}: ${r.message}`;
      if (r.packs) setPacks(r.packs);
    } catch (e) {
      message = errorText(e);
    }
    setLog((l) => [{ id: ++seq, code: lotCode, ok, message, at: new Date().toISOString() }, ...l].slice(0, 30));
    if (ok) notifyDataChanged();
  }

  return (
    <>
      <PageTitle title="Open lot" subtitle="Opening a case or tray makes its packs individually movable. The lot itself stays here as OPENED." />
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card>
          <ScanInput label="Lot code" onScan={onScan} demoScreen="open" />
          <div className="mt-4">
            <ScanLog entries={log} />
          </div>
        </Card>
        {packs.length > 0 && (
          <Card title="Packs now movable">
            <ul className="space-y-1 text-sm">
              {packs.map((p) => (
                <li key={p.packCode} className="flex items-center gap-2">
                  <Code>{p.packCode}</Code> <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
