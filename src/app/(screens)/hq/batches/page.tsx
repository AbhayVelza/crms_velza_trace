"use client";

// Batch report (printed / packed / quarantined / void / reprinted) and recall + recall report.

import { useState } from "react";
import { IconChevronRight, IconTriangleAlert } from "@/components/icons";
import { Button, Card, Code, cx, Empty, Field, fmtTime, Input, Loading, Notice, PageTitle, Stat, StatusBadge, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

interface BatchRow {
  code: string;
  flavourName: string;
  mfgDate: string;
  expiryDate: string;
  manufacturer: string;
  status: string;
  lots: number;
  statusCounts: Record<string, number>;
  reprints: number;
  createdAt: string;
}

interface Report {
  batch: BatchRow & { recalledAt: string | null; recallReason: string | null };
  summary: { lots: number; cases: number; trays: number; printed: number; packed: number; quarantined: number; void: number; reprinted: number; recalled: number };
  lots: { code: string; lotType: string; status: string; location: string; quarantineReason: string | null }[];
}

interface RecallReport {
  batch: { code: string; flavour: string; status: string; recalledAt: string | null; recallReason: string | null };
  items: { code: string; lotType: string; status: string; statusBeforeRecall: string | null; lastLocation: string | null; packs: { code: string; statusBeforeRecall: string | null; lastLocation: string | null }[] }[];
}

export default function BatchesPage() {
  const list = useApi<BatchRow[]>("/api/batches", { refreshOnChange: true });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <PageTitle title="Batches & recall" />
      {list.error && <Notice tone="error">{list.error}</Notice>}
      <Card className="mb-4 lg:mb-5">
        <Table head={["Batch", "Flavour", "Mfg / Exp", "Lots", "Statuses", "Reprints", ""]} empty={list.data && !list.data.length ? <Empty>No synced batches yet</Empty> : null}>
          {list.data?.map((b) => (
            <tr key={b.code} className={cx(selected === b.code && "bg-muted shadow-[inset_2px_0_0_var(--foreground)]")} aria-selected={selected === b.code}>
              <Td>
                <Code>{b.code}</Code> {b.status === "RECALLED" && <StatusBadge status="RECALLED" />}
              </Td>
              <Td>{b.flavourName}</Td>
              <Td className="whitespace-nowrap text-xs">
                {b.mfgDate} / {b.expiryDate}
              </Td>
              <Td>{b.lots}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(b.statusCounts).map(([s, n]) => (
                    <span key={s} className="text-xs">
                      <StatusBadge status={s} /> {n}
                    </span>
                  ))}
                </div>
              </Td>
              <Td>{b.reprints}</Td>
              <Td>
                <Button variant="ghost" className="min-h-8 px-3" onClick={() => setSelected(b.code)}>
                  Report
                  <IconChevronRight size={16} />
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {selected && <BatchReport key={selected} code={selected} />}
    </>
  );
}

function BatchReport({ code }: { code: string }) {
  const report = useApi<Report>(`/api/batches/${code}`, { refreshOnChange: true });
  const recalled = report.data?.batch.status === "RECALLED";
  const recallReport = useApi<RecallReport>(recalled ? `/api/recall?batchCode=${code}` : null, { refreshOnChange: true });
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function recall() {
    setMsg(null);
    try {
      const r = await api<RecallReport>("/api/recall", { body: { batchCode: code, reason } });
      setMsg({ tone: "ok", text: `Batch ${code} recalled: ${r.items.length} lot(s) marked RECALLED` });
      setConfirming(false);
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  if (report.error) return <Notice tone="error">{report.error}</Notice>;
  const r = report.data;
  if (!r) return <Loading>Loading report…</Loading>;

  return (
    <div className="animate-rise-in space-y-4 lg:space-y-5" data-testid="batch-report">
      <Card title={`Batch ${code} · ${r.batch.flavourName} · ${r.batch.manufacturer}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7 lg:gap-4">
          <Stat label="Lots" value={`${r.summary.lots}`} />
          <Stat label="Printed" value={r.summary.printed} />
          <Stat label="Packed" value={r.summary.packed} />
          <Stat label="Quarantined" value={r.summary.quarantined} tone={r.summary.quarantined ? "warn" : undefined} />
          <Stat label="Void" value={r.summary.void} />
          <Stat label="Reprinted" value={r.summary.reprinted} />
          <Stat label="Recalled" value={r.summary.recalled} tone={r.summary.recalled ? "danger" : undefined} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {r.summary.cases} case(s), {r.summary.trays} tray(s). Printed / packed count lots that ever reached that step (from the movement ledger).
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card title="Lots">
          <Table head={["Lot", "Type", "Status", "Location"]}>
            {r.lots.map((l) => (
              <tr key={l.code}>
                <Td>
                  <Code>{l.code}</Code>
                </Td>
                <Td className="text-xs">{l.lotType}</Td>
                <Td>
                  <StatusBadge status={l.status} />
                  {l.quarantineReason && <div className="text-xs text-warning">{l.quarantineReason}</div>}
                </Td>
                <Td className="text-xs">{l.location}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Recall">
          {recalled ? (
            <div className="space-y-3">
              <Notice tone="error">
                Recalled {fmtTime(r.batch.recalledAt)} — {r.batch.recallReason}
              </Notice>
              <h3 className="text-sm font-bold text-foreground">Recall report: last known location</h3>
              {recallReport.data && (
                <ul className="space-y-2 text-sm" data-testid="recall-report">
                  {recallReport.data.items.map((i) => (
                    <li key={i.code} className="rounded-control border border-line bg-surface-2 p-3">
                      <Code>{i.code}</Code> <span className="text-xs text-muted-foreground">{i.lotType}, was {i.statusBeforeRecall ?? i.status}</span>
                      <div className="text-xs">{i.lastLocation}</div>
                      {i.packs.length > 0 && (
                        <ul className="mt-2 space-y-0.5 border-l-2 border-line-strong pl-3 text-xs">
                          {i.packs.map((p) => (
                            <li key={p.code}>
                              <Code>{p.code}</Code> was {p.statusBeforeRecall} · {p.lastLocation}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-foreground-2">Recall marks every lot and pack of this batch RECALLED wherever it is. Any later scan raises a BLOCKED_CODE alert and the public page shows &quot;Recalled — do not consume&quot;.</p>
              <Field label="Reason">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Quality complaint, contamination risk" />
              </Field>
              {!confirming ? (
                <Button variant="danger" disabled={!reason.trim()} onClick={() => setConfirming(true)}>
                  Recall batch {code}
                </Button>
              ) : (
                <div className="flex animate-rise-in flex-wrap items-center gap-2 rounded-control border border-danger-line bg-danger-soft p-3">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-danger">
                    <IconTriangleAlert size={17} />
                    This cannot be undone.
                  </span>
                  <Button variant="danger" onClick={recall}>
                    Yes, recall {r.summary.lots} lot(s)
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
          {msg && (
            <Notice tone={msg.tone} className="mt-3">
              {msg.text}
            </Notice>
          )}
        </Card>
      </div>
    </div>
  );
}
