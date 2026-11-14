"use client";

import Link from "next/link";
import { useState } from "react";
import { IconTriangleAlert } from "@/components/icons";
import { Button, Card, Code, cx, Empty, fmtTime, Notice, PageTitle, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

type AlertState = "OPEN" | "ACKNOWLEDGED" | "CLOSED";

interface AlertRow {
  id: string;
  type: string;
  at: string;
  code: string;
  message: string;
  partner: string | null;
  user: string | null;
  /** Damage alerts: the photo of the damaged item with its barcode, then the extra photos of the damage. */
  photoUrls?: string[];
  count?: number;
  firstAt?: string;
  state: AlertState;
  stateAt: string | null;
  stateByName: string | null;
  stateNote: string | null;
}

interface AlertPage {
  items: AlertRow[];
  total: number;
  limit: number;
  offset: number;
  counts: { byState: Record<string, number>; byType: Record<string, number> };
}

const CHIP = "inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors duration-150";
const CHIP_ON = "border-primary bg-primary text-primary-foreground";
const CHIP_OFF = "border-line-strong bg-surface text-foreground-2 hover:border-foreground/40 hover:bg-muted";

const TYPES = ["NOT_RECEIVED", "WRONG_RECEIVER", "UNKNOWN_CODE", "DUPLICATE_RECEIPT", "BLOCKED_CODE", "DAMAGED", "SUSPECT_CLONE", "PUBLIC_UNKNOWN", "PUBLIC_BLOCKED"];
const STATES: { key: AlertState | "ALL"; label: string }[] = [
  { key: "OPEN", label: "Open" },
  { key: "ACKNOWLEDGED", label: "Acknowledged" },
  { key: "CLOSED", label: "Closed" },
  { key: "ALL", label: "All" },
];
const PAGE = 50;

export default function AlertsPage() {
  const [state, setState] = useState<AlertState | "ALL">("OPEN");
  const [filter, setFilter] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const path = `/api/alerts?state=${state}&limit=${PAGE}&offset=${offset}${filter ? `&type=${filter}` : ""}`;
  const { data, error } = useApi<AlertPage>(path, { refreshOnChange: true });
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  async function act(a: AlertRow, action: "ACKNOWLEDGE" | "CLOSE" | "REOPEN") {
    setMsg(null);
    setBusy(`${a.id}|${action}`);
    try {
      await api("/api/alerts", { body: { alertId: a.id, action } });
      setMsg({ tone: "ok", text: `${a.type.replace(/_/g, " ")} ${a.code} ${action === "ACKNOWLEDGE" ? "acknowledged" : action === "CLOSE" ? "closed" : "reopened"}` });
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const pick = (s: AlertState | "ALL") => (setState(s), setOffset(0));
  const pickType = (t: string | null) => (setFilter(t), setOffset(0));

  return (
    <>
      <PageTitle title="Alerts" subtitle="Computed from the scan audit log, damage reports and items in transit. Acknowledge an alert you are handling; close it when it is resolved." />
      {error && <Notice tone="error">{error}</Notice>}
      {msg && (
        <Notice tone={msg.tone} className="mb-3">
          {msg.text}
        </Notice>
      )}
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter by state">
        {STATES.map((s) => (
          <button key={s.key} type="button" aria-pressed={state === s.key} onClick={() => pick(s.key)} className={cx(CHIP, state === s.key ? CHIP_ON : CHIP_OFF)}>
            {s.label} ({data?.counts.byState[s.key] ?? 0})
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by type">
        <button type="button" aria-pressed={!filter} onClick={() => pickType(null)} className={cx(CHIP, !filter ? CHIP_ON : CHIP_OFF)}>
          All types
        </button>
        {TYPES.map((t) => (
          <button key={t} type="button" aria-pressed={filter === t} onClick={() => pickType(t)} className={cx(CHIP, filter === t ? CHIP_ON : CHIP_OFF)}>
            {t.replace(/_/g, " ")} ({data?.counts.byType[t] ?? 0})
          </button>
        ))}
      </div>
      <Card>
        <Table head={["Time", "Type", "Code", "Message", "Where / who", "State"]} empty={rows.length ? null : <Empty>No alerts</Empty>}>
          {rows.map((a) => (
            <tr key={a.id} data-testid="alert-row">
              <Td className="whitespace-nowrap text-muted-foreground">
                {fmtTime(a.at)}
                {a.count && a.count > 1 && a.firstAt && <div className="text-xs">since {fmtTime(a.firstAt)}</div>}
              </Td>
              <Td className="whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold tracking-wide text-danger">
                  <IconTriangleAlert size={16} />
                  {a.type}
                </span>
                {a.count && a.count > 1 && <div className="text-xs text-muted-foreground">×{a.count}</div>}
              </Td>
              <Td>
                {a.code ? (
                  <Link href={`/hq/search?code=${encodeURIComponent(a.code)}`} className="underline-offset-4 hover:underline">
                    <Code>{a.code}</Code>
                  </Link>
                ) : (
                  <span className="text-subtle-foreground">—</span>
                )}
              </Td>
              <Td>
                {a.message}
                {!!a.photoUrls?.length && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {a.photoUrls.map((url, i) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer" className="block w-fit" data-testid="alert-photo">
                        {/* eslint-disable-next-line @next/next/no-img-element -- private photo from our own API */}
                        <img src={url} alt={i ? `Damage photo ${i} of ${a.code}` : `Photo of damaged ${a.code} with its barcode`} className="h-16 w-16 rounded-md border border-line object-cover" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
              </Td>
              <Td className="text-xs text-muted-foreground">
                {a.partner}
                {a.user && <div>{a.user}</div>}
              </Td>
              <Td className="text-xs">
                <div className="font-semibold">{a.state.toLowerCase()}</div>
                {a.state !== "OPEN" && (
                  <div className="text-muted-foreground">
                    {a.stateByName} · {fmtTime(a.stateAt)}
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {a.state === "OPEN" && (
                    <Button variant="secondary" className="px-3 py-1 text-xs" loading={busy === `${a.id}|ACKNOWLEDGE`} disabled={!!busy} onClick={() => act(a, "ACKNOWLEDGE")}>
                      Acknowledge
                    </Button>
                  )}
                  {a.state !== "CLOSED" && (
                    <Button variant="secondary" className="px-3 py-1 text-xs" loading={busy === `${a.id}|CLOSE`} disabled={!!busy} onClick={() => act(a, "CLOSE")}>
                      Close
                    </Button>
                  )}
                  {a.state !== "OPEN" && (
                    <Button variant="ghost" className="px-3 py-1 text-xs" loading={busy === `${a.id}|REOPEN`} disabled={!!busy} onClick={() => act(a, "REOPEN")}>
                      Reopen
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
        {total > PAGE && (
          <div className="mt-3 flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </Button>
              <Button variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
