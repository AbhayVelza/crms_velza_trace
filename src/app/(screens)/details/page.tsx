"use client";

// Product details: scan a case, tray or pack to see what it is (batch, manufacture and expiry date) and the partners
// it came through to reach you. At a Retailer the Super Stockist and Distributor it came from are shown first.

import { useState } from "react";
import { ScanInput } from "@/components/ScanInput";
import { useSession } from "@/components/session";
import { Card, Code, cx, fmtTime, Notice, PageTitle, StatusBadge } from "@/components/ui";
import { useApi } from "@/components/useApi";

interface Step {
  partnerId: string;
  name: string;
  tier: string;
  tierLabel: string;
  receivedAt: string | null;
  invoice: string | null;
  you: boolean;
  onTheWay: boolean;
}
interface Found {
  found: true;
  code: string;
  kind: "LOT" | "PACK";
  lotType: "CASE" | "TRAY";
  lotCode: string;
  flavour: string;
  batchCode: string;
  mfgDate: string | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  expired: boolean;
  packSize: number;
  packLabel: string | null;
  manufacturer: string;
  status: string | null;
  position: string;
  supplyChain: Step[];
  cameFrom: { warehouse: string | null; superStockist: string | null; distributor: string | null };
  recalled: boolean;
}
type Result = Found | { found: false; code: string; result: string; message: string };

/** "2026-11-01" → "1 Nov 2026" (dates are calendar dates: no time zone shift). */
function fmtDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function expiryText(r: Found): string {
  if (r.daysToExpiry === null) return "";
  if (r.expired) return `Expired ${-r.daysToExpiry} day${r.daysToExpiry === -1 ? "" : "s"} ago`;
  if (r.daysToExpiry === 0) return "Expires today";
  return `${r.daysToExpiry} day${r.daysToExpiry === 1 ? "" : "s"} left`;
}

export default function DetailsPage() {
  const { partner } = useSession();
  const [query, setQuery] = useState<string | null>(null);
  const { data: result, error, reload } = useApi<Result>(query ? `/api/details/${encodeURIComponent(query)}` : null);
  const scan = (code: string) => (code === query ? reload() : setQuery(code));
  return (
    <>
      <PageTitle title="Product details" subtitle="Scan a case, tray or pack: batch, manufacture and expiry date, and where it came from." />
      <Card className="mb-4 lg:mb-5">
        <ScanInput label="Code" onScan={scan} />
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      {result && !result.found && (
        <Notice tone="error">
          <span data-testid="details-error">{result.message}</span>
        </Notice>
      )}
      {result?.found && <Details r={result} retailer={partner?.type === "RETAILER"} />}
    </>
  );
}

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </>
  );
}

function Details({ r, retailer }: { r: Found; retailer: boolean }) {
  const expiry = expiryText(r);
  return (
    <div className="animate-rise-in space-y-4 lg:space-y-5" data-testid="details-result">
      {r.recalled && <Notice tone="error">This batch is recalled — do not sell or use it.</Notice>}
      {!r.recalled && r.expired && <Notice tone="error">This product is past its expiry date — do not sell it.</Notice>}

      {retailer && (
        <Card title="Came to you from">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <Row label="Super Stockist" testId="came-from-ss">
              {r.cameFrom.superStockist ?? "—"}
            </Row>
            <Row label="Distributor" testId="came-from-db">
              {r.cameFrom.distributor ?? (r.cameFrom.superStockist ? "— (supplied by the Super Stockist directly)" : "—")}
            </Row>
            {r.cameFrom.warehouse && <Row label="Velza Warehouse">{r.cameFrom.warehouse}</Row>}
          </dl>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card title={r.kind === "PACK" ? "Pack" : r.lotType === "CASE" ? "Case" : "Tray"}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <Row label="Code">
              <Code>{r.code}</Code>
            </Row>
            {r.packLabel && (
              <Row label="Pack">
                {r.packLabel} · from {r.lotType.toLowerCase()} <Code>{r.lotCode}</Code>
              </Row>
            )}
            {!r.packLabel && <Row label="Packs inside">{r.packSize}</Row>}
            <Row label="Flavour">{r.flavour}</Row>
            <Row label="Where it is" testId="details-position">
              {r.position} {r.status && <StatusBadge status={r.status} />}
            </Row>
          </dl>
        </Card>
        <Card title="Batch">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <Row label="Batch No." testId="details-batch">
              <Code>{r.batchCode}</Code>
            </Row>
            <Row label="Mfg. date" testId="details-mfg">
              {fmtDate(r.mfgDate)}
            </Row>
            <Row label="Expiry date" testId="details-exp">
              {fmtDate(r.expiryDate)} {expiry && <span className={cx("ml-1 text-xs", r.expired ? "text-danger" : r.daysToExpiry !== null && r.daysToExpiry <= 30 ? "text-warning" : "text-muted-foreground")}>({expiry})</span>}
            </Row>
            <Row label="Manufacturer">{r.manufacturer}</Row>
          </dl>
        </Card>
      </div>

      <Card title="Supply chain to you">
        <ol className="space-y-2 text-sm" data-testid="details-chain">
          {r.supplyChain.map((s, i) => (
            <li key={`${s.partnerId}-${i}`} className={cx("flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1", s.you && "bg-surface-2 font-semibold")}>
              <span className="w-5 text-muted-foreground">{i + 1}.</span>
              <span className="min-w-36 text-muted-foreground">{s.tierLabel}</span>
              <span>
                {s.name}
                {s.you && " (you)"}
              </span>
              <span className="text-xs text-muted-foreground">
                {s.onTheWay ? "on its way" : s.receivedAt ? `received ${fmtTime(s.receivedAt)}` : ""}
                {s.invoice ? ` · invoice ${s.invoice}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
