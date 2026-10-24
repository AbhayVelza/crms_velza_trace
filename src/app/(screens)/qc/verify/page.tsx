"use client";

// Supervisor/QC verification (spec 6.4): scan lot → checklist of expected packs → scan packs → confirm or quarantine.

import { useState } from "react";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { useSession } from "@/components/session";
import { Button, Card, Code, cx, Field, Input, Notice, PageTitle, StatusBadge } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

interface LotView {
  lotCode: string;
  lotType: "CASE" | "TRAY";
  flavour: string;
  status: string;
  batchCode: string;
  synced: boolean;
  expectedPacks: string[];
}

interface VerifyResult {
  ok: boolean;
  code?: string;
  message: string;
  lot?: LotView;
}

let seq = 0;

export default function VerifyPage() {
  const { flavourName } = useSession();
  const [lot, setLot] = useState<LotView | null>(null);
  const [scanned, setScanned] = useState<string[]>([]);
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const addLog = (code: string, ok: boolean, message: string) =>
    setLog((l) => [{ id: ++seq, code, ok, message, at: new Date().toISOString() }, ...l].slice(0, 30));

  async function post(body: object): Promise<VerifyResult | null> {
    try {
      return await api<VerifyResult>("/api/verify", { body });
    } catch (e) {
      setOutcome({ tone: "error", text: errorText(e) });
      return null;
    }
  }

  async function onScan(code: string) {
    setOutcome(null);
    if (!lot) {
      const r = await post({ action: "scanLot", code });
      if (!r) return;
      addLog(code, r.ok, r.message);
      if (r.ok && r.lot) {
        setLot(r.lot);
        setScanned([]);
      }
      return;
    }
    const r = await post({ action: "scanPack", lotCode: lot.lotCode, code, scanned });
    if (!r) return;
    addLog(code, r.ok, r.message);
    if (r.ok) setScanned((s) => [...s, code]);
  }

  async function finish(action: "confirm" | "quarantine") {
    if (!lot) return;
    setBusy(true);
    const r = await post(action === "confirm" ? { action, lotCode: lot.lotCode, packCodes: scanned } : { action, lotCode: lot.lotCode, reason, packCodes: scanned });
    setBusy(false);
    if (!r) return;
    setOutcome({ tone: r.ok ? "ok" : "warn", text: r.message });
    notifyDataChanged();
    setLot(null);
    setScanned([]);
    setReason("");
  }

  const complete = lot && scanned.length === lot.expectedPacks.length;

  return (
    <>
      <PageTitle title="Verify lots" subtitle="Scan the lot sticker, then every pack sticker pasted inside it." />
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title={lot ? "2. Scan each pack" : "1. Scan the lot sticker"}>
          <ScanInput
            key={lot?.lotCode ?? "lot"}
            label={lot ? `Pack code (${scanned.length}/${lot.expectedPacks.length})` : "Lot code"}
            onScan={onScan}
            demoScreen="verify"
            demoLotCode={lot?.lotCode}
          />
          {outcome && (
            <Notice tone={outcome.tone} className="mt-3">
              {outcome.text}
            </Notice>
          )}
          <div className="mt-4">
            <ScanLog entries={log} />
          </div>
        </Card>

        <Card title="Checklist">
          {!lot ? (
            <p className="text-sm text-slate-500">Scan a lot to see its expected packs.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Code>{lot.lotCode}</Code>
                <span>
                  {lot.lotType} · {flavourName(lot.flavour)} · {lot.lotType === "CASE" ? "4 packs × 6 cans" : "6 packs × 4 cans"}
                </span>
                <StatusBadge status={lot.status} />
                {!lot.synced && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">unsynced</span>}
              </div>
              <ul className="grid gap-1.5 sm:grid-cols-2" data-testid="checklist">
                {lot.expectedPacks.map((p, i) => {
                  const done = scanned.includes(p);
                  return (
                    <li key={p} data-done={done} className={cx("flex items-center gap-2 rounded-md border px-3 py-2 text-sm", done ? "border-green-300 bg-green-50" : "border-slate-200")}>
                      <span className={cx("inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold", done ? "bg-green-600 text-white" : "bg-slate-200 text-slate-500")}>{done ? "✓" : i + 1}</span>
                      <Code>{p}</Code>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => finish("confirm")} disabled={!complete || busy}>
                  Confirm → PACKED
                </Button>
                <Button variant="secondary" onClick={() => (setLot(null), setScanned([]))} disabled={busy}>
                  Cancel
                </Button>
              </div>
              <div className="rounded-md border border-orange-200 bg-orange-50 p-3">
                <Field label="Quarantine with reason">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Pack sticker missing, wrong flavour inside" />
                </Field>
                <Button variant="danger" className="mt-2" onClick={() => finish("quarantine")} disabled={!reason.trim() || busy}>
                  Quarantine lot
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
