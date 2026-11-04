"use client";

// Search any code: status, location, parent/children, full timeline.

import { useState } from "react";
import { ScanInput } from "@/components/ScanInput";
import { Card, Code, Empty, fmtTime, Notice, PageTitle, StatusBadge, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";

interface Found {
  found: true;
  code: string;
  kind: "LOT" | "PACK";
  status: string;
  location: string;
  quarantineReason: string | null;
  batch: { code: string; flavour: string; mfgDate: string; expiryDate: string; status: string; manufacturer: string } | null;
  parent: { code: string; status: string; lotType: string; location: string } | null;
  lot: { code: string; lotType: string; packSize: number };
  children: { code: string; seq: number; status: string; location: string }[];
  timeline: { at: string; event: string; itemCode: string; from: string | null; to: string | null; fromStatus: string | null; toStatus: string | null; user: string | null; device: string | null; invoice: string | null; note: string | null }[];
  reprints: { id: string; at: string; code: string; reason: string; userName: string | null }[];
}
type Result = Found | { found: false; code: string; result: string; message: string };

export default function SearchPage() {
  // Deep link: /hq/search?code=... (read once on the client; the server render has no code).
  const [query, setQuery] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("code")));
  const { data: result, error, reload } = useApi<Result>(query ? `/api/lookup/${encodeURIComponent(query)}` : null);

  const search = (code: string) => {
    window.history.replaceState(null, "", `/hq/search?code=${encodeURIComponent(code)}`);
    if (code === query) reload();
    else setQuery(code);
  };

  return (
    <>
      <PageTitle title="Search code" subtitle="Lot or pack code (or a scanned QR URL)." />
      <Card className="mb-4 lg:mb-5">
        <ScanInput label="Code" onScan={search} demoScreen="search" />
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      {result && !result.found && (
        <Notice tone="error">
          <b>{result.result}</b>: {result.message}
        </Notice>
      )}
      {result?.found && <Details r={result} onOpen={search} />}
    </>
  );
}

function Details({ r, onOpen }: { r: Found; onOpen: (code: string) => void }) {
  return (
    <div className="animate-rise-in space-y-4 lg:space-y-5" data-testid="search-result">
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
        <Card title={r.kind === "LOT" ? `${r.lot.lotType} lot` : "Pack"}>
          <div className="space-y-2 text-sm">
            <div>
              <Code>{r.code}</Code>
            </div>
            <div>
              Status: <StatusBadge status={r.status} />
            </div>
            <div data-testid="search-location">Location: {r.location}</div>
            {r.quarantineReason && <div className="text-warning">Quarantine reason: {r.quarantineReason}</div>}
          </div>
        </Card>
        {r.batch && (
          <Card title="Batch">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Code</dt>
              <dd>
                <Code>{r.batch.code}</Code> {r.batch.status === "RECALLED" && <StatusBadge status="RECALLED" />}
              </dd>
              <dt className="text-muted-foreground">Flavour</dt>
              <dd>{r.batch.flavour}</dd>
              <dt className="text-muted-foreground">Mfg / Exp</dt>
              <dd>
                {r.batch.mfgDate} / {r.batch.expiryDate}
              </dd>
              <dt className="text-muted-foreground">Maker</dt>
              <dd>{r.batch.manufacturer}</dd>
            </dl>
          </Card>
        )}
        <Card title={r.parent ? "Parent lot" : `Packs (${r.children.length})`}>
          {r.parent ? (
            <button type="button" className="-m-2 w-[calc(100%+1rem)] space-y-1 rounded-control p-2 text-left text-sm transition-colors duration-150 hover:bg-muted" onClick={() => onOpen(r.parent!.code)}>
              <div>
                <Code>{r.parent.code}</Code> <StatusBadge status={r.parent.status} />
              </div>
              <div className="text-muted-foreground">{r.parent.location}</div>
            </button>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {r.children.map((c) => (
                <li key={c.code}>
                  <button type="button" className="text-left underline-offset-4 hover:underline" onClick={() => onOpen(c.code)}>
                    <Code>{c.code}</Code>
                  </button>{" "}
                  <StatusBadge status={c.status} /> <span className="text-xs text-muted-foreground">{c.location}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Timeline">
        <Table head={["Time", "Event", "Item", "From → To", "Status", "User", "Device", "Invoice", "Note"]} empty={r.timeline.length ? null : <Empty>No events</Empty>}>
          {r.timeline.map((t, i) => (
            <tr key={i} data-testid="timeline-row">
              <Td className="whitespace-nowrap text-muted-foreground">{fmtTime(t.at)}</Td>
              <Td className="whitespace-nowrap text-xs font-bold tracking-wide">{t.event}</Td>
              <Td>
                <Code>{t.itemCode}</Code>
              </Td>
              <Td className="text-xs">{t.from || t.to ? `${t.from ?? "—"} → ${t.to ?? "—"}` : "—"}</Td>
              <Td className="whitespace-nowrap text-xs">{t.toStatus ? `${t.fromStatus ?? "—"} → ${t.toStatus}` : ""}</Td>
              <Td className="text-xs">{t.user}</Td>
              <Td className="text-xs">{t.device}</Td>
              <Td className="text-xs">{t.invoice}</Td>
              <Td className="text-xs">{t.note}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      {r.reprints.length > 0 && (
        <Card title="Reprints">
          <ul className="text-sm">
            {r.reprints.map((p) => (
              <li key={p.id}>
                {fmtTime(p.at)} · <Code>{p.code}</Code> · {p.reason} · {p.userName}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
