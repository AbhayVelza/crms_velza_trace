"use client";

// Product details: scan a case, tray or pack to see what it is (batch, manufacture and expiry date) and the partners
// it came through to reach you. At a Retailer the Super Stockist and Distributor it came from are shown first.
// Velza HQ, Admin and field staff see the full chain, the current holder and status. For field staff scanning here
// only VIEWS (it never receives anything); "Take back" sends the item to the Velza Warehouse.

import { useState } from "react";
import { ScanInput } from "@/components/ScanInput";
import { useSession } from "@/components/session";
import { Button, Card, Code, cx, Field, fmtTime, Input, Notice, PageTitle, Select, StatusBadge } from "@/components/ui";
import { useAction } from "@/components/useAction";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

interface Step {
  partnerId: string;
  name: string;
  tier: string;
  tierLabel: string;
  receivedAt: string | null;
  invoice: string | null;
  you: boolean;
  onTheWay: boolean;
  returned?: boolean;
}
interface FullView {
  holder: string;
  holderTier: string | null;
  location: string;
  canTakeBack: boolean;
  returns: { at: string; from: string | null; reason: string | null; by: string | null; decision: string | null }[];
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
  packsInLot: number;
  packLabel: string | null;
  manufacturer: string;
  status: string | null;
  position: string;
  supplyChain: Step[];
  cameFrom: { warehouse: string | null; superStockist: string | null; distributor: string | null };
  recalled: boolean;
  full?: FullView;
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
  const { partner, role } = useSession();
  const field = role === "VELZA_FIELD";
  const [query, setQuery] = useState<string | null>(null);
  const { data: result, error, reload } = useApi<Result>(query ? `/api/details/${encodeURIComponent(query)}` : null);
  const scan = (code: string) => (code === query ? reload() : setQuery(code));
  return (
    <>
      <PageTitle
        title={field ? "Scan" : "Product details"}
        subtitle={
          field
            ? "View only: scanning shows the full chain and never receives anything. Use Take back to send stock to the Velza Warehouse."
            : "Scan a case, tray or pack: batch, manufacture and expiry date, and where it came from."
        }
      />
      <Card className="mb-4 lg:mb-5">
        <ScanInput label="Code" onScan={scan} />
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      {result && !result.found && (
        <Notice tone="error">
          <span data-testid="details-error">{result.message}</span>
        </Notice>
      )}
      {result?.found && result.full && <FullInfo r={result} full={result.full} onChanged={reload} />}
      {result?.found && !result.full && <Details r={result} retailer={partner?.type === "RETAILER"} />}
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
            {!r.packLabel && (
              <Row label="Packs inside">
                {r.packsInLot} packs of {r.packSize} cans
              </Row>
            )}
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

const REASONS = [
  { value: "NOT_SELLING", label: "Not selling" },
  { value: "NEAR_EXPIRY", label: "Near expiry" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "OTHER", label: "Other (note)" },
] as const;

/** Velza HQ, Admin and field staff: the full chain, holder, status and dates; Take back for field staff. */
function FullInfo({ r, full, onChanged }: { r: Found; full: FullView; onChanged: () => void }) {
  const expiry = expiryText(r);
  // Kept here: after a take-back the item reloads and the Take back form is gone, the confirmation stays.
  const [taken, setTaken] = useState<{ code: string; text: string } | null>(null);
  return (
    <div className="animate-rise-in space-y-4 lg:space-y-5" data-testid="details-result">
      {taken?.code === r.code && (
        <Notice tone="ok">
          <span data-testid="take-back-result">{taken.text}</span>
        </Notice>
      )}
      {r.recalled && <Notice tone="error">This batch is recalled — do not sell or use it.</Notice>}
      {!r.recalled && r.expired && <Notice tone="error">This product is past its expiry date — do not sell it.</Notice>}
      <Card title={`${r.kind === "PACK" ? "Pack" : r.lotType === "CASE" ? "Case" : "Tray"} ${r.code}`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
          <Row label="Current holder" testId="info-holder">
            {full.holder}
            {full.holderTier && <span className="text-muted-foreground"> · {full.holderTier}</span>}
          </Row>
          <Row label="Status" testId="info-status">
            {r.status && <StatusBadge status={r.status} />}
          </Row>
          <Row label="Location">{full.location}</Row>
          <Row label="Flavour">
            {r.flavour}
            {r.packLabel && <span className="text-muted-foreground"> · {r.packLabel}</span>}
          </Row>
          <Row label="Batch No." testId="details-batch">
            <Code>{r.batchCode}</Code>
          </Row>
          <Row label="Mfg. date" testId="details-mfg">
            {fmtDate(r.mfgDate)}
          </Row>
          <Row label="Expiry date" testId="details-exp">
            {fmtDate(r.expiryDate)}
          </Row>
          <Row label="Days to expiry" testId="info-days">
            <span className={cx(r.expired ? "text-danger" : r.daysToExpiry !== null && r.daysToExpiry <= 30 ? "text-warning" : "")}>{expiry || "—"}</span>
          </Row>
        </dl>
      </Card>

      <Card title="Full chain">
        <ol className="space-y-2 text-sm" data-testid="details-chain">
          {r.supplyChain.map((s, i) => (
            <li key={`${s.partnerId}-${i}`} data-testid="chain-step" className="flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1">
              <span className="w-5 text-muted-foreground">{i + 1}.</span>
              <span className="min-w-36 text-muted-foreground">{s.returned ? "Return →" : ""} {s.tierLabel}</span>
              <span className="font-medium">{s.name}</span>
              <span className="text-xs text-muted-foreground">
                {s.onTheWay ? (s.returned ? "being taken back" : "on its way") : s.receivedAt ? `received ${fmtTime(s.receivedAt)}` : i === 0 ? "made here" : ""}
                {s.invoice ? ` · invoice ${s.invoice}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      {full.returns.length > 0 && (
        <Card title="Take-backs">
          <ul className="space-y-1 text-sm" data-testid="info-returns">
            {full.returns.map((x) => (
              <li key={x.at}>
                {fmtTime(x.at)} · from {x.from ?? "—"} · {x.reason ?? "—"} · by {x.by ?? "—"} · <b>{x.decision ?? "not inspected yet"}</b>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {full.canTakeBack && (
        <TakeBack
          code={r.code}
          kind={r.kind}
          lotType={r.lotType}
          onDone={(text) => {
            setTaken({ code: r.code, text });
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function TakeBack({ code, kind, lotType, onDone }: { code: string; kind: "LOT" | "PACK"; lotType: "CASE" | "TRAY"; onDone: (message: string) => void }) {
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const what = kind === "PACK" ? "pack" : lotType === "CASE" ? "case" : "tray";
  const [busy, submit] = useAction(async () => {
    try {
      const r = await api<{ message: string }>("/api/returns/take-back", { body: { code, reason, note } });
      setError(null);
      notifyDataChanged();
      onDone(r.message);
    } catch (e) {
      setError(errorText(e));
    }
  });
  const ready = !!reason && (reason !== "OTHER" || !!note.trim());
  return (
    <Card title={`Take back this ${what}`}>
      <p className="mb-3 text-sm text-muted-foreground">
        It leaves the partner&apos;s stock and goes to the Velza Warehouse (RETURN IN TRANSIT).{kind === "PACK" ? " If its case or tray is still sealed, it is opened first." : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
        <Field label="Reason">
          <Select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose…</option>
            {REASONS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={reason === "OTHER" ? "Note (required)" : "Note (optional)"}>
          <Input aria-label="Note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="What the partner said, what you saw" />
        </Field>
        <Button onClick={() => void submit()} disabled={!ready} loading={busy}>
          Take back
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
