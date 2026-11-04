"use client";

import { Code, Empty, fmtTime, Pill, StatusBadge, Table, Td } from "./ui";

export interface StockItem {
  code: string;
  kind: "LOT" | "PACK";
  lotType: "CASE" | "TRAY";
  flavour: string;
  batchCode: string;
  status: string;
  synced: boolean;
  from: string | null;
  to: string | null;
  dispatchedAt: string | null;
}

export function StockTable({ items, show = "status", empty = "Nothing here" }: { items: StockItem[]; show?: "status" | "from" | "to"; empty?: string }) {
  return (
    <Table
      head={["Code", "What", "Batch", show === "from" ? "From" : show === "to" ? "To" : "Status", ...(show === "status" ? [] : ["Dispatched"])]}
      empty={items.length ? null : <Empty>{empty}</Empty>}
    >
      {items.map((i) => (
        <tr key={i.code}>
          <Td>
            <Code>{i.code}</Code>
          </Td>
          <Td className="whitespace-nowrap">
            {i.kind === "LOT" ? i.lotType.toLowerCase() : "pack"} · {i.flavour}
          </Td>
          <Td>
            <Code>{i.batchCode}</Code>
          </Td>
          <Td>
            {show === "from" ? i.from : show === "to" ? i.to : <StatusBadge status={i.status} />}
            {!i.synced && (
              <Pill tone="warn" className="ml-2">
                unsynced
              </Pill>
            )}
          </Td>
          {show !== "status" && <Td className="whitespace-nowrap text-xs text-muted-foreground">{fmtTime(i.dispatchedAt)}</Td>}
        </tr>
      ))}
    </Table>
  );
}
