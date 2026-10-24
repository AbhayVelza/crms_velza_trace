"use client";

import { Code, Empty, fmtTime, StatusBadge, Table, Td } from "./ui";

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
            {!i.synced && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">unsynced</span>}
          </Td>
          {show !== "status" && <Td className="whitespace-nowrap text-xs text-slate-500">{fmtTime(i.dispatchedAt)}</Td>}
        </tr>
      ))}
    </Table>
  );
}
