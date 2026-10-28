"use client";

// Every code a print order generated, with every field stored for it, the sticker totals and whether
// the codes have reached the central database. Downloadable as CSV.

import { useSession } from "./session";
import { IconDownload } from "./icons";
import { Button, Card, Code, Empty, fmtTime, Loading, Notice, Stat, StatusBadge, Table, Td } from "./ui";
import { useApi } from "./useApi";
import type { CodeRow } from "@/lib/services/printOrders";

interface CodesData {
  printOrder: { id: string; createdAt: string; synced: boolean };
  totals: { stickers: number; cases: number; trays: number; packs: number; synced: number; unsynced: number };
  codes: CodeRow[];
}

const COLUMNS: [keyof CodeRow, string][] = [
  ["code", "code"],
  ["codeType", "code_type"],
  ["countryCode", "country_code"],
  ["batchCode", "batch_code"],
  ["flavour", "flavour"],
  ["hexCode", "hex_code"],
  ["lotType", "lot_type"],
  ["packSize", "pack_size"],
  ["packSequence", "pack_sequence"],
  ["lotCode", "lot_code"],
  ["mfgDate", "mfg_date"],
  ["expiryDate", "expiry_date"],
  ["manufacturerId", "manufacturer_id"],
  ["status", "status"],
  ["locationId", "location_id"],
  ["synced", "synced"],
  ["generatedAt", "generated_at"],
  ["generatedBy", "generated_by"],
];

function downloadCsv(name: string, rows: CodeRow[]) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [COLUMNS.map(([, h]) => h).join(","), ...rows.map((r) => COLUMNS.map(([k]) => cell(r[k])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export function GeneratedCodes({ printOrderId }: { printOrderId: string }) {
  const { flavourName } = useSession();
  const { data, error } = useApi<CodesData>(`/api/print-orders/${printOrderId}/codes`, { refreshOnChange: true });
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading>Loading codes…</Loading>;
  const t = data.totals;
  return (
    <Card
      title="Generated codes"
      actions={
        <Button variant="secondary" className="min-h-8 px-3 py-1 text-xs" onClick={() => downloadCsv(`codes-${printOrderId.slice(0, 8)}.csv`, data.codes)}>
          <IconDownload size={16} />
          Download CSV
        </Button>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="code-totals">
        <Stat label="Stickers" value={t.stickers} />
        <Stat label="Cases" value={t.cases} hint="1 lot + 4 packs each" />
        <Stat label="Trays" value={t.trays} hint="1 lot + 6 packs each" />
        <Stat label="Pack stickers" value={t.packs} />
        <Stat label="Synced" value={`${t.synced} / ${t.stickers}`} tone={t.unsynced ? "warn" : undefined} hint={t.unsynced ? "Plant PC offline: syncs when back online" : "In the central database"} />
      </div>
      <div className="max-h-[28rem] overflow-auto">
        <Table head={["Code", "Type", "Country", "Batch", "Flavour", "Hex", "Lot type", "Pack size", "Pack #", "Lot code", "Mfg", "Expiry", "Manufacturer", "Status", "Location", "Synced", "Generated", "By"]} empty={data.codes.length ? null : <Empty>No codes</Empty>}>
          {data.codes.map((c) => (
            <tr key={c.code} data-testid="code-row" className={c.codeType === "LOT" ? "bg-surface-2" : undefined}>
              <Td>
                <Code>{c.code}</Code>
              </Td>
              <Td className="text-xs">{c.codeType}</Td>
              <Td>{c.countryCode}</Td>
              <Td className="font-mono text-xs">{c.batchCode}</Td>
              <Td className="text-xs">
                {c.flavour} <span className="text-muted-foreground">{flavourName(c.flavour)}</span>
              </Td>
              <Td className="font-mono text-xs">{c.hexCode}</Td>
              <Td className="text-xs">{c.lotType}</Td>
              <Td>{c.packSize}</Td>
              <Td>{c.packSequence ?? "—"}</Td>
              <Td className="font-mono text-xs">{c.lotCode}</Td>
              <Td className="whitespace-nowrap text-xs">{c.mfgDate}</Td>
              <Td className="whitespace-nowrap text-xs">{c.expiryDate}</Td>
              <Td className="font-mono text-xs">{c.manufacturerId}</Td>
              <Td>
                <StatusBadge status={c.status} />
              </Td>
              <Td className="font-mono text-xs">{c.locationId}</Td>
              <Td>{c.synced ? "yes" : <span className="font-semibold text-warning">no</span>}</Td>
              <Td className="whitespace-nowrap text-xs">{fmtTime(c.generatedAt)}</Td>
              <Td className="font-mono text-xs">{c.generatedBy}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}
