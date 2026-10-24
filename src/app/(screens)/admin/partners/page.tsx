"use client";

import { AdminCrud } from "@/components/AdminCrud";
import { useSession } from "@/components/session";
import { Notice, PageTitle } from "@/components/ui";
import { PARTNER_TYPE_LABELS, PARTNER_TYPES } from "@/lib/core/types";

const order = (t: unknown) => PARTNER_TYPES.indexOf(t as (typeof PARTNER_TYPES)[number]);

export default function PartnersPage() {
  const { data } = useSession();
  const superStockists = (data?.partners ?? []).filter((p) => p.type === "SS");
  return (
    <>
      <PageTitle title="Partners" subtitle="Every tier of the chain: Manufacturer → Super Stockist → Distributor → Supplier → Outlet" />
      <AdminCrud
        entity="partners"
        title="Partners"
        intro={
          <Notice tone="info">
            Assign each <b>Distributor</b> to a <b>Super Stockist</b>: a Super Stockist can only see and dispatch to the distributors assigned to it.
            Partners with history can&apos;t be deleted — untick <b>Active</b> instead.
          </Notice>
        }
        sort={(a, b) => order(a.type) - order(b.type) || String(a.name).localeCompare(String(b.name))}
        columns={[
          { key: "type", label: "Tier", type: "select", createOnly: true, options: () => PARTNER_TYPES.map((t) => ({ value: t, label: PARTNER_TYPE_LABELS[t] })) },
          { key: "name", label: "Name", type: "text", placeholder: "e.g. SS-3 Bengaluru Stockist" },
          { key: "city", label: "City", type: "text", placeholder: "City" },
          { key: "territory", label: "Territory", type: "text", placeholder: "e.g. East & South Maharashtra" },
          {
            key: "parentId",
            label: "Assigned Super Stockist",
            type: "select",
            nullable: true,
            visible: (row) => row.type === "DB",
            options: () => superStockists.map((p) => ({ value: p.id, label: p.name })),
          },
          { key: "active", label: "Active", type: "bool" },
        ]}
      />
    </>
  );
}
