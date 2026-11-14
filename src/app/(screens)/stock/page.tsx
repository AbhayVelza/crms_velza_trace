"use client";

import { StockTable, type StockItem } from "@/components/StockTable";
import { useSession } from "@/components/session";
import { Card, Notice, PageTitle, Stat } from "@/components/ui";
import { useApi } from "@/components/useApi";

interface Stock {
  counts: { cases: number; trays: number; openedCases: number; openedTrays: number; loosePacks: number };
  inStock: StockItem[];
  outgoing: StockItem[];
  incoming: StockItem[];
  /** Recalled stock held here (also units recalled while in transit to here): do not sell. */
  recalled?: StockItem[];
  /** At the plant: lots not yet finished stock. */
  pending?: { awaitingPrint: number; awaitingQc: number; quarantined: number };
}

export default function StockPage() {
  const { partner } = useSession();
  const { data, error } = useApi<Stock>("/api/stock", { refreshOnChange: true });
  const recalled = data?.recalled ?? [];
  const pending = data?.pending;
  const pendingHint =
    pending && (pending.awaitingPrint || pending.awaitingQc || pending.quarantined)
      ? [
          pending.awaitingPrint && `${pending.awaitingPrint} lot(s) not printed yet`,
          pending.awaitingQc && `${pending.awaitingQc} lot(s) awaiting QC`,
          pending.quarantined && `${pending.quarantined} quarantined`,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  return (
    <>
      <PageTitle title="My stock" subtitle={partner?.name} />
      {error && <Notice tone="error">{error}</Notice>}
      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Cases here" value={data.counts.cases} hint={data.counts.openedCases ? `${data.counts.openedCases} opened` : undefined} />
            <Stat label="Trays here" value={data.counts.trays} hint={data.counts.openedTrays ? `${data.counts.openedTrays} opened` : undefined} />
            <Stat label="Loose packs" value={data.counts.loosePacks} />
            <Stat label="Incoming" value={data.incoming.length} tone={data.incoming.length ? "warn" : undefined} />
          </div>
          {pendingHint && (
            <Notice tone="info" className="mb-4">
              Not counted as stock yet: {pendingHint}.
            </Notice>
          )}
          <div className="space-y-4">
            {recalled.length > 0 && (
              <Card title={`Recalled — do not sell (${recalled.length})`}>
                <StockTable items={recalled} empty="Nothing recalled here" />
              </Card>
            )}
            <Card title={`At my location (${data.inStock.length})`}>
              <StockTable items={data.inStock} empty="No stock here" />
            </Card>
            <Card title={`Incoming — in transit to me (${data.incoming.length})`}>
              <StockTable items={data.incoming} show="from" empty="Nothing incoming" />
            </Card>
            <Card title={`Outgoing — dispatched, not yet received (${data.outgoing.length})`}>
              <StockTable items={data.outgoing} show="to" empty="Nothing outgoing" />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
