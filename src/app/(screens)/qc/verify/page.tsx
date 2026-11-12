"use client";

// Supervisor/QC verification (spec 6.4): scan lot → checklist of its expected packs (from the server) → scan each
// pack (each one checked by the server) → Confirm → PACKED only when every pack passed, or quarantine with a reason.

import { useRef, useState } from "react";
import { ScanChecklist, useChecklist } from "@/components/ScanChecklist";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { useSession } from "@/components/session";
import { Button, Card, Code, Field, Input, Notice, PageTitle, Pill, StatusBadge } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import { applyAccepted, applyRejected, countChecklist } from "@/lib/scan/checklist";
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
  const [lot, setLotState] = useState<LotView | null>(null);
  const lotRef = useRef<LotView | null>(null);
  const packs = useChecklist();
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const setLot = (l: LotView | null) => {
    lotRef.current = l;
    setLotState(l);
    packs.reset(l ? l.expectedPacks.map((code, i) => ({ code, kind: "PACK" as const, label: `Pack ${i + 1}` })) : []);
  };
  const scannedPacks = () => packs.ref.current.rows.filter((r) => r.status === "SCANNED").map((r) => r.code);
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
    const current = lotRef.current;
    if (!current) {
      const r = await post({ action: "scanLot", code });
      if (!r) return addLog(code, false, "Not checked (connection or server problem) — scan it again");
      addLog(code, r.ok, r.message);
      if (r.ok && r.lot) setLot(r.lot);
      return;
    }
    // The server checks the pack against this lot and against the packs already accepted (duplicates).
    const r = await post({ action: "scanPack", lotCode: current.lotCode, code, scanned: scannedPacks() });
    if (!r) return addLog(code, false, "Not checked (connection or server problem) — scan it again");
    addLog(code, r.ok, r.message);
    packs.update((s) => (r.ok ? applyAccepted(s, code, r.message) : applyRejected(s, code, r.code, r.message)));
  }

  async function finish(action: "confirm" | "quarantine") {
    const current = lotRef.current;
    if (!current) return;
    setBusy(true);
    const packCodes = scannedPacks();
    const r = await post(action === "confirm" ? { action, lotCode: current.lotCode, packCodes } : { action, lotCode: current.lotCode, reason, packCodes });
    setBusy(false);
    if (!r) return;
    setOutcome({ tone: r.ok ? "ok" : "warn", text: r.message });
    notifyDataChanged();
    setLot(null);
    setReason("");
  }

  const counts = countChecklist(packs.state);
  const complete = !!lot && counts.complete;

  return (
    <>
      <PageTitle title="Verify lots" subtitle="Scan the lot sticker, then every pack sticker pasted inside it." />
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr] lg:gap-5">
        <Card title={lot ? "2. Scan each pack" : "1. Scan the lot sticker"}>
          {/* Not re-mounted when the lot changes: a pack scanned right after the lot (still queued) must not be lost. */}
          <ScanInput
            label={lot ? `Pack code (${counts.scanned}/${counts.expected})` : "Lot code"}
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
            <p className="text-sm text-muted-foreground">Scan a lot to see its expected packs.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Code>{lot.lotCode}</Code>
                <span>
                  {lot.lotType} · {flavourName(lot.flavour)} · {lot.lotType === "CASE" ? "4 packs × 6 cans" : "6 packs × 4 cans"}
                </span>
                <StatusBadge status={lot.status} />
                {!lot.synced && <Pill tone="warn">unsynced</Pill>}
              </div>
              <ScanChecklist
                state={packs.state}
                title="Packs in this lot"
                completeText={`All ${counts.expected} packs passed — press Confirm → PACKED`}
              />
              {!complete && counts.scanned > 0 && (
                <p className="text-sm text-muted-foreground" data-testid="missing-packs">
                  {counts.pending} pack{counts.pending === 1 ? "" : "s"} still missing. Confirm unlocks when every pack has passed; if a pack sticker is missing or wrong, quarantine the lot.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => finish("confirm")} disabled={!complete || busy} loading={busy}>
                  Confirm → PACKED
                </Button>
                <Button variant="secondary" onClick={() => setLot(null)} disabled={busy}>
                  Cancel
                </Button>
              </div>
              <div className="rounded-control border border-warning-line bg-warning-soft p-3 sm:p-4">
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
