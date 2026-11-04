"use client";

import Link from "next/link";
import { useSession } from "@/components/session";
import { IconListChecks, IconPrinter } from "@/components/icons";
import { PRINT_CONFIRMATION_NOTE, PrintOrderStatus } from "@/components/PrintOrderStatus";
import { Card, Code, Empty, fmtTime, Notice, PageTitle, Pill, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { PrintOrder } from "@/lib/core/types";

interface OrderRow extends PrintOrder {
  createdByName: string;
  batches: { code: string; flavour: string; synced: boolean; cases: number; trays: number }[];
}

export default function PrintOrdersPage() {
  const { flavourName } = useSession();
  const { data, error } = useApi<OrderRow[]>("/api/print-orders", { refreshOnChange: true });
  const pending = data?.filter((o) => o.status !== "PRINTED").length ?? 0;
  return (
    <>
      <PageTitle title="Print orders" subtitle="Open the print view again at any time; reprinting the whole order does not create new codes." />
      {error && <Notice tone="error">{error}</Notice>}
      {pending > 0 && (
        <Notice tone="warn" className="mb-4">
          {pending} print order{pending === 1 ? " is" : "s are"} printing pending: open the print view to finish printing. {PRINT_CONFIRMATION_NOTE}
        </Notice>
      )}
      <Card>
        <Table head={["Created", "Batches", "Stickers", "Status", "Synced", ""]} empty={data && !data.length ? <Empty>No print orders yet</Empty> : null}>
          {data?.map((o) => (
            <tr key={o.id}>
              <Td className="whitespace-nowrap">
                {fmtTime(o.createdAt)}
                <div className="text-xs text-muted-foreground">{o.createdByName}</div>
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
                <PrintOrderStatus order={o} />
              </Td>
              <Td>{o.synced ? "yes" : <Pill tone="warn">no</Pill>}</Td>
              <Td className="whitespace-nowrap">
                <Link className="inline-flex min-h-11 items-center gap-1 rounded px-1 font-semibold text-foreground underline-offset-4 hover:underline" href={`/print/${o.id}`}>
                  <IconPrinter size={16} />
                  {o.status === "PRINTED" ? "Print view" : "Finish printing"}
                </Link>
                <span className="text-line-strong"> · </span>
                <Link className="inline-flex min-h-11 items-center gap-1 rounded px-1 font-semibold text-foreground underline-offset-4 hover:underline" href={`/operator/orders/${o.id}`}>
                  <IconListChecks size={16} />
                  Codes
                </Link>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
