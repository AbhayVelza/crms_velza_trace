"use client";

// Dispatch (scan OUT): destination (an allowed tier, assigned partners only) → invoice/challan → scan codes into a list → confirm.
// The checklist shows the stock here that can be dispatched; each scan is checked by the server before it is ticked,
// and nothing moves until Confirm dispatch.

import { useEffect, useRef, useState } from "react";
import { ScanChecklist, useChecklist } from "@/components/ScanChecklist";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import type { StockItem } from "@/components/StockTable";
import { Button, Card, Field, Input, Loading, Notice, PageTitle, Select } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { assignedTypesOf, AT_STATUS } from "@/lib/core/rules";
import { applyAccepted, applyRejected, rebaseChecklist, resetAll, resetItem, type ChecklistItem } from "@/lib/scan/checklist";
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
  const stock = useApi<{ inStock: StockItem[] }>("/api/stock", { refreshOnChange: true });
  const [to, setTo] = useState("");
  const [invoice, setInvoice] = useState("");
  // Codes accepted into this dispatch, in scan order (the checklist ticks the ones that are on the stock list).
  const [list, setList] = useState<{ code: string; kind: string }[]>([]);
  const listRef = useRef(list);
  const checklist = useChecklist();
  const updateChecklist = checklist.update; // stable: safe as an effect dependency
  const senderType = dest.data?.sender.type;

  // Expected = what the server would let this partner dispatch: synced, here, and at this tier's status.
  useEffect(() => {
    if (!stock.data || !senderType) return;
    const expected: ChecklistItem[] = stock.data.inStock
      .filter((i) => i.synced && i.status === AT_STATUS[senderType])
      .map((i) => ({ code: i.code, kind: i.kind, label: `${i.kind === "PACK" ? "Pack" : i.lotType === "CASE" ? "Case" : "Tray"} · ${i.flavour}`, group: i.batchCode }));
    updateChecklist((s) => rebaseChecklist(s, expected));
  }, [stock.data, senderType, updateChecklist]);

  const setListBoth = (next: { code: string; kind: string }[]) => {
    listRef.current = next;
    setList(next);
  };
  const clearList = () => {
    setListBoth([]);
    checklist.update(resetAll);
  };
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = !!to && !!invoice.trim();
  const addLog = (code: string, ok: boolean, message: string) => setLog((l) => [{ id: ++seq, code, ok, message, at: new Date().toISOString() }, ...l].slice(0, 50));

  async function onScan(code: string) {
    setResult(null);
    try {
      // The server checks receiver, invoice, status, location and duplicates in this list (logged in the scan audit).
      const r = await api<{ ok: boolean; code?: string; message: string; kind?: string }>("/api/dispatch", {
        body: { action: "check", toPartnerId: to || null, invoice, code, listed: listRef.current.map((l) => l.code) },
      });
      addLog(code, r.ok, r.ok ? r.message : `${r.code}: ${r.message}`);
      if (r.ok) setListBoth([...listRef.current, { code, kind: r.kind ?? "" }]);
      checklist.update((s) => (r.ok ? applyAccepted(s, code, r.message) : applyRejected(s, code, r.code, r.message)));
    } catch (e) {
      addLog(code, false, `Not checked: ${errorText(e)} — scan it again`);
    }
  }

  function remove(code: string) {
    setListBoth(listRef.current.filter((l) => l.code !== code));
    checklist.update((s) => resetItem(s, code));
  }

  async function confirm() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ message: string }>("/api/dispatch", { body: { action: "confirm", toPartnerId: to, invoice, codes: list.map((l) => l.code) } });
      setResult({ tone: "ok", text: r.message });
      clearList();
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
  // The manufacturer ships only to the Velza Warehouse; the warehouse supplies any SS, DB or Retailer;
  // SS and DB only the partners assigned to them.
  const assigned = assignedTypesOf(sender.type).length > 0;
  const scope = assigned ? " assigned to you" : sender.type === "WAREHOUSE" ? " (any)" : " only";
  const tiers = destinationTypes.map((t) => `${PARTNER_TYPE_LABELS[t]}s`).join(" or ");
  const option = (p: Partner) => (
    <option key={p.id} value={p.id}>
      {p.name} ({p.city})
    </option>
  );

  return (
    <>
      <PageTitle title="Dispatch (scan OUT)" subtitle={`From ${sender.name}${tiers ? ` → ${tiers}${scope}` : ""}`} />
      {!destinationTypes.length ? (
        <Notice tone="info">Retailers are the last tier and don&apos;t dispatch.</Notice>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
          <Card title="1–2. Destination and invoice">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Destination (${destinationTypes.map((t) => PARTNER_TYPE_LABELS[t]).join(" or ")})`}>
                <Select aria-label="Destination" value={to} onChange={(e) => (setTo(e.target.value), clearList())}>
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
            {list.length === 0 && <p className="mb-3 text-sm text-muted-foreground">Scanned codes are ticked below; only ticked codes are dispatched.</p>}
            {list.some((l) => !checklist.state.index.has(l.code)) && (
              <Notice tone="info" className="mb-3">
                Also in this dispatch: {list.filter((l) => !checklist.state.index.has(l.code)).map((l) => l.code).join(", ")}
              </Notice>
            )}
            <ScanChecklist
              state={checklist.state}
              title="Stock that can be dispatched"
              groupLabel="Batch"
              emptyText={stock.data ? "Nothing here can be dispatched right now." : "Loading stock…"}
              completeText="Every unit that can be dispatched is in the list."
              rowAction={(code) =>
                list.some((l) => l.code === code) ? (
                  <button type="button" className="min-h-9 rounded px-2 text-xs text-danger hover:underline" onClick={() => remove(code)} aria-label={`Remove ${code} from the dispatch`}>
                    Remove
                  </button>
                ) : null
              }
            />
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
