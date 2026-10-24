"use client";

import { useApi } from "@/components/useApi";
import { Card, Empty, Notice, PageTitle, Table, Td } from "@/components/ui";
import type { Partner } from "@/lib/core/types";

interface Data {
  superStockist: Partner;
  distributors: (Partner & { lotsInStock: number; loosePacksInStock: number; lotsOnTheWayFromMe: number })[];
}

export default function MyDistributorsPage() {
  const { data, error } = useApi<Data>("/api/distributors", { refreshOnChange: true });
  return (
    <>
      <PageTitle
        title="My distributors"
        subtitle={data ? `${data.superStockist.name}${data.superStockist.territory ? ` · ${data.superStockist.territory}` : ""}` : undefined}
      />
      {error && <Notice tone="error">{error}</Notice>}
      <Card title="Assigned to you by Velza Admin">
        <Table head={["Distributor", "City", "Territory", "Lots in stock", "Loose packs", "On the way from you"]} empty={data?.distributors.length ? null : <Empty>No distributors assigned yet — ask Velza Admin</Empty>}>
          {data?.distributors.map((d) => (
            <tr key={d.id}>
              <Td>
                {d.name}
                {!d.active && <span className="ml-2 text-xs text-slate-500">(inactive)</span>}
              </Td>
              <Td>{d.city}</Td>
              <Td>{d.territory || "—"}</Td>
              <Td>{d.lotsInStock}</Td>
              <Td>{d.loosePacksInStock}</Td>
              <Td>{d.lotsOnTheWayFromMe}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
