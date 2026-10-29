"use client";

// Dispatch (scan OUT): destination (an allowed tier, assigned partners only) → invoice/challan → scan codes into a list → confirm.

import { useState } from "react";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { Button, Card, Code, Field, Input, Loading, Notice, PageTitle, Select } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { assignedTypesOf } from "@/lib/core/rules";
import { PARTNER_TYPE_LABELS, type Partner, type PartnerType } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";

interface Destinations {
  sender: Partner;
  destinationTypes: PartnerType[];
  destinations: Partner[];
}

let seq = 0;

export default function DispatchPage() {
  const dest = useApi<Destinations>("/api/dispatch");
  const [to, setTo] = useState("");
  const [invoice, setInvoice] = useState("");
  const [list, setList] = useState<{ code: string; kind: string }[]>([]);
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = !!to && !!invoice.trim();
  const addLog = (code: string, ok: boolean, message: string) => setLog((l) => [{ id: ++seq, code, ok, message, at: new Date().toISOString() }, ...l].slice(0, 50));

  async function onScan(code: string) {
    setResult(null);
    try {
      const r = await api<{ ok: boolean; code?: string; message: string; kind?: string }>("/api/dispatch", {
        body: { action: "check", toPartnerId: to || null, invoice, code, listed: list.map((l) => l.code) },
      });
      addLog(code, r.ok, r.ok ? r.message : `${r.code}: ${r.message}`);
      if (r.ok) setList((l) => [...l, { code, kind: r.kind ?? "" }]);
    } catch (e) {
      addLog(code, false, errorText(e));
    }
  }

  async function confirm() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ message: string }>("/api/dispatch", { body: { action: "confirm", toPartnerId: to, invoice, codes: list.map((l) => l.code) } });
      setResult({ tone: "ok", text: r.message });
      setList([]);
      setInvoice("");
      notifyDataChanged();
    } catch (e) {
      setResult({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (dest.error) return <Notice tone="error">{dest.error}</Notice>;
  if (!dest.data) return <Loading />;
  const { destinationTypes, destinations, sender } = dest.data;
  // The manufacturer may supply any Super Stockist; SS and DB only the partners assigned to them.
  const assigned = assignedTypesOf(sender.type).length > 0;
  const tiers = destinationTypes.map((t) => `${PARTNER_TYPE_LABELS[t]}s`).join(" or ");
  const option = (p: Partner) => (
    <option key={p.id} value={p.id}>
      {p.name} ({p.city})
    </option>
  );

  return (
    <>
      <PageTitle title="Dispatch (scan OUT)" subtitle={`From ${sender.name}${tiers ? ` → ${tiers}${assigned ? " assigned to you" : " only"}` : ""}`} />
      {!destinationTypes.length ? (
        <Notice tone="info">Retailers are the last tier and don&apos;t dispatch.</Notice>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
          <Card title="1–2. Destination and invoice">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Destination (${destinationTypes.map((t) => PARTNER_TYPE_LABELS[t]).join(" or ")})`}>
                <Select aria-label="Destination" value={to} onChange={(e) => (setTo(e.target.value), setList([]))}>
                  <option value="">Choose…</option>
                  {destinationTypes.length > 1
                    ? destinationTypes
                        .filter((t) => destinations.some((p) => p.type === t))
                        .map((t) => (
                        <optgroup key={t} label={`${PARTNER_TYPE_LABELS[t]}s`}>
                          {destinations
                            .filter((p) => p.type === t)
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map(option)}
                        </optgroup>
                      ))
                    : destinations.map(option)}
                </Select>
              </Field>
              <Field label="Invoice / challan number">
                <Input aria-label="Invoice" value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="e.g. INV-001" />
              </Field>
            </div>
            <div className="mt-4">
              {ready ? (
                <ScanInput label="3. Scan codes into the list" onScan={onScan} demoScreen="dispatch" />
              ) : (
                <Notice tone="info">Choose the destination and enter the invoice/challan number, then scan.</Notice>
              )}
            </div>
            <div className="mt-4">
              <ScanLog entries={log} />
            </div>
          </Card>
          <Card title={`4. Dispatch list (${list.length})`}>
            {list.length === 0 ? (
              <p className="text-sm text-muted-foreground">Scanned codes appear here.</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="dispatch-list">
                {list.map((l) => (
                  <li key={l.code} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      <Code>{l.code}</Code> <span className="text-xs text-muted-foreground">{l.kind}</span>
                    </span>
                    <button type="button" className="text-xs text-danger hover:underline" onClick={() => setList((x) => x.filter((y) => y.code !== l.code))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button className="mt-4 w-full sm:w-auto" onClick={confirm} disabled={!ready || !list.length} loading={busy}>
              Confirm dispatch of {list.length} item{list.length === 1 ? "" : "s"}
            </Button>
            {result && (
              <Notice tone={result.tone} className="mt-3">
                {result.text}
              </Notice>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
