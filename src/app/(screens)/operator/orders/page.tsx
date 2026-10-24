"use client";

import Link from "next/link";
import { useSession } from "@/components/session";
import { Card, Code, Empty, fmtTime, Notice, PageTitle, StatusBadge, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { PrintOrder } from "@/lib/core/types";

interface OrderRow extends PrintOrder {
  createdByName: string;
  batches: { code: string; flavour: string; synced: boolean; cases: number; trays: number }[];
}

export default function PrintOrdersPage() {
  const { flavourName } = useSession();
  const { data, error } = useApi<OrderRow[]>("/api/print-orders", { refreshOnChange: true });
  return (
    <>
      <PageTitle title="Print orders" subtitle="Open the print view again at any time; reprinting the whole order does not create new codes." />
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        <Table head={["Created", "Batches", "Stickers", "Status", "Synced", ""]} empty={data && !data.length ? <Empty>No print orders yet</Empty> : null}>
          {data?.map((o) => (
            <tr key={o.id}>
              <Td className="whitespace-nowrap">
                {fmtTime(o.createdAt)}
                <div className="text-xs text-slate-500">{o.createdByName}</div>
              </Td>
              <Td>
                {o.batches.map((b) => (
                  <div key={b.code}>
                    <Code>{b.code}</Code> {flavourName(b.flavour)} · {b.cases} case(s), {b.trays} tray(s)
                  </div>
                ))}
              </Td>
              <Td>{o.stickerCount}</Td>
              <Td>
                <StatusBadge status={o.status} />
              </Td>
              <Td>{o.synced ? "yes" : <span className="font-semibold text-amber-700">no</span>}</Td>
              <Td>
                <Link className="font-medium text-teal-800 hover:underline" href={`/print/${o.id}`}>
                  Print view
                </Link>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
