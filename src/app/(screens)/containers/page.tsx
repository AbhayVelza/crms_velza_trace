"use client";

// Shipping containers plant → Customs. Operator: open a container by its own number, scan cases and trays into it,
// dispatch it whole to Customs. Customs: receives it (Receive page), then marks it cleared here — only then can its
// cases and trays go to Super Stockists. Velza HQ follows every container.

import { useState } from "react";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { useSession } from "@/components/session";
import { Button, Card, Code, fmtTime, Field, Input, Loading, Notice, PageTitle, Pill, Select, StatusBadge, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import type { Container, Partner } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";

interface Row extends Container {
  lots: number;
  /** Detail only: how many of its cases/trays have reached Customs. */
  receivedCount?: number;
  total?: number;
  manufacturer: string | null;
  to: string | null;
}
interface Detail {
  container: Row;
  capacity: number;
  cases: number;
  trays: number;
  lots: { code: string; lotType: string | null; status: string | null }[];
}

const STATUS_LABEL: Record<Container["status"], string> = { LOADING: "Loading", IN_TRANSIT: "On the way", RECEIVED: "At customs — awaiting clearance", CLEARED: "Cleared at customs" };
const STATUS_TONE = { LOADING: "warn", IN_TRANSIT: "neutral", RECEIVED: "warn", CLEARED: "ok" } as const;

let seq = 0;

export default function ContainersPage() {
  const { role } = useSession();
  const list = useApi<{ capacity: number; containers: Row[] }>("/api/containers", { refreshOnChange: true });
  const [openId, setOpenId] = useState<string | null>(null);
  const operator = role === "OPERATOR";
  const customs = role === "WAREHOUSE";

  return (
    <>
      <PageTitle
        title="Containers"
        subtitle={
          operator
            ? "Open a container by its own number, scan cases and trays into it, then dispatch it whole to Customs"
            : customs
              ? "Containers from the plant. Receive one on Receive (scan its number), then open it here and Mark cleared once customs has cleared it — only cleared cases and trays can go to Super Stockists."
              : "Shipping containers from the plant to Customs: received, then cleared by the Velza person at Customs."
        }
      />
      <div className="space-y-4">
        {operator && <NewContainer onCreated={(id) => setOpenId(id)} />}
        {openId && <ContainerDetail id={openId} operator={operator} customs={customs} onClose={() => setOpenId(null)} />}
        <Card title="All containers">
          {list.error && <Notice tone="error">{list.error}</Notice>}
          {!list.data && !list.error && <Loading />}
          {list.data && (
            <Table
              head={["Container", "Status", "Cases & trays", "From", "To", "Invoice", "Dispatched", "Received", "Cleared", ""]}
              empty={!list.data.containers.length ? <span className="text-muted-foreground">No containers yet.</span> : null}
            >
              {list.data.containers.map((c) => (
                <tr key={c.id} data-testid={`container-${c.code}`}>
                  <Td>
                    <Code>{c.code}</Code>
                  </Td>
                  <Td>
                    <Pill tone={STATUS_TONE[c.status]} dot>
                      {STATUS_LABEL[c.status]}
                    </Pill>
                  </Td>
                  <Td>
                    {c.lots.toLocaleString("en-IN")} / {list.data!.capacity.toLocaleString("en-IN")}
                  </Td>
                  <Td>{c.manufacturer}</Td>
                  <Td>{c.to ?? "—"}</Td>
                  <Td>{c.invoice ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-xs">{c.dispatchedAt ? fmtTime(c.dispatchedAt) : "—"}</Td>
                  <Td className="whitespace-nowrap text-xs">{c.receivedAt ? fmtTime(c.receivedAt) : "—"}</Td>
                  <Td className="whitespace-nowrap text-xs">{c.clearedAt ? fmtTime(c.clearedAt) : "—"}</Td>
                  <Td>
                    <Button variant="secondary" onClick={() => setOpenId(c.id)}>
                      {operator && c.status === "LOADING" ? "Load" : customs && c.status === "RECEIVED" ? "Clear" : "Open"}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

function NewContainer({ onCreated }: { onCreated: (id: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ container: Container }>("/api/containers", { body: { code } });
      setCode("");
      notifyDataChanged();
      onCreated(r.container.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="1. New container">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Container number (as printed on the container)" hint="e.g. MSCU1234567 — letters, digits and dashes">
          <Input aria-label="Container number" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MSCU1234567" className="font-mono" />
        </Field>
        <Button onClick={create} disabled={!code.trim()} loading={busy}>
          Open container
        </Button>
      </div>
      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
    </Card>
  );
}

function ContainerDetail({ id, operator, customs, onClose }: { id: string; operator: boolean; customs: boolean; onClose: () => void }) {
  const detail = useApi<Detail>(`/api/containers/${id}`, { refreshOnChange: true });
  const dest = useApi<{ destinations: Partner[] }>(operator ? "/api/dispatch" : null);
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [to, setTo] = useState("");
  const [invoice, setInvoice] = useState("");
  const [billOfEntry, setBillOfEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const addLog = (code: string, ok: boolean, message: string) => setLog((l) => [{ id: ++seq, code, ok, message, at: new Date().toISOString() }, ...l].slice(0, 50));

  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <Loading />;
  const { container: c, capacity, cases, trays, lots } = detail.data;
  const loading = operator && c.status === "LOADING";
  const warehouses = dest.data?.destinations ?? [];
  const target = to || (warehouses.length === 1 ? warehouses[0].id : "");

  async function onScan(code: string) {
    try {
      const r = await api<{ ok: boolean; code?: string; message: string }>(`/api/containers/${id}/load`, { body: { code } });
      addLog(code, r.ok, r.ok ? r.message : `${r.code}: ${r.message}`);
      // Refresh both this panel and the "All containers" list (its count must follow every load).
      if (r.ok) notifyDataChanged();
    } catch (e) {
      addLog(code, false, errorText(e));
    }
  }
  async function unload(code: string) {
    try {
      await api(`/api/containers/${id}/unload`, { body: { code } });
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }
  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`/api/containers/${id}/dispatch`, { body: { toPartnerId: target, invoice } });
      setMsg({ tone: "ok", text: r.message });
      notifyDataChanged();
    } catch (e) {
      // errorText lists each case/tray that can't go and why.
      setMsg({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`/api/containers/${id}/clear`, { body: { billOfEntry: billOfEntry.trim() || undefined } });
      setMsg({ tone: "ok", text: r.message });
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    try {
      await api(`/api/containers/${id}`, { method: "DELETE" });
      notifyDataChanged();
      onClose();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <span>
          Container <Code>{c.code}</Code> · {STATUS_LABEL[c.status]}
        </span>
      }
      actions={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted-foreground" data-testid="container-count">
        {lots.length.toLocaleString("en-IN")} / {capacity.toLocaleString("en-IN")} cases & trays ({cases} cases, {trays} trays)
        {c.to ? ` · to ${c.to}` : ""}
        {c.invoice ? ` · ${c.invoice}` : ""}
        {c.status === "CLEARED" && c.clearedAt ? ` · cleared ${fmtTime(c.clearedAt)}${c.billOfEntry ? ` · Bill of Entry ${c.billOfEntry}` : ""}` : ""}
      </p>
      {customs && c.status === "RECEIVED" && (
        <div className="mb-4 space-y-3 rounded-md border border-line bg-surface-2 p-3" data-testid="customs-clear">
          <div className="text-sm font-bold">Customs clearance</div>
          <p className="text-sm text-muted-foreground">
            {(c.receivedCount ?? 0).toLocaleString("en-IN")} of {(c.total ?? lots.length).toLocaleString("en-IN")} cases & trays received here.
            {(c.receivedCount ?? 0) < (c.total ?? lots.length) ? " The rest are cleared as they arrive." : ""}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Bill of Entry number (optional)">
              <Input aria-label="Bill of Entry" value={billOfEntry} maxLength={40} onChange={(e) => setBillOfEntry(e.target.value)} placeholder="e.g. 1234567" />
            </Field>
            <Button onClick={clear} loading={busy}>
              Mark cleared
            </Button>
          </div>
        </div>
      )}
      <div className={loading ? "grid gap-4 lg:grid-cols-2 lg:gap-5" : ""}>
        {loading && (
          <div className="space-y-4">
            <ScanInput label="2. Scan cases and trays into the container" onScan={onScan} />
            <ScanLog entries={log} />
            <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
              <div className="text-sm font-bold">3. Dispatch the container</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Destination (Customs)">
                  <Select aria-label="Container destination" value={target} onChange={(e) => setTo(e.target.value)}>
                    <option value="">Choose…</option>
                    {warehouses.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.city})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Invoice / challan number">
                  <Input aria-label="Container invoice" value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="e.g. INV-001" />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={send} disabled={!target || !invoice.trim() || !lots.length} loading={busy}>
                  Dispatch container ({lots.length})
                </Button>
                <Button variant="secondary" onClick={cancel} disabled={busy}>
                  Cancel container
                </Button>
              </div>
            </div>
          </div>
        )}
        <div>
          {msg && (
            <Notice tone={msg.tone} className="mb-3">
              {msg.text}
            </Notice>
          )}
          <Table head={["Case / tray", "Type", "Status", ""]} empty={!lots.length ? <span className="text-muted-foreground">Nothing loaded yet.</span> : null}>
            {lots.map((l) => (
              <tr key={l.code} data-testid="container-lot">
                <Td>
                  <Code>{l.code}</Code>
                </Td>
                <Td>{l.lotType ?? "—"}</Td>
                <Td>{l.status ? <StatusBadge status={l.status} /> : "—"}</Td>
                <Td>
                  {loading && (
                    <button type="button" className="text-xs text-danger hover:underline" onClick={() => void unload(l.code)}>
                      Take out
                    </button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      </div>
    </Card>
  );
}
