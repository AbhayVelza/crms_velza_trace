"use client";

import { AdminCrud } from "@/components/AdminCrud";
import { PageTitle } from "@/components/ui";
import { PARTNER_TYPE_LABELS, PARTNER_TYPES } from "@/lib/core/types";

const order = (t: unknown) => PARTNER_TYPES.indexOf(t as (typeof PARTNER_TYPES)[number]);

export default function PartnersPage() {
  return (
    <>
      <PageTitle title="Partners" subtitle="Every tier of the chain: Manufacturer → Super Stockist → Distributor → Supplier → Outlet" />
      <AdminCrud
        entity="partners"
        title="Partners"
        sort={(a, b) => order(a.type) - order(b.type) || String(a.name).localeCompare(String(b.name))}
        columns={[
          { key: "type", label: "Tier", type: "select", createOnly: true, options: () => PARTNER_TYPES.map((t) => ({ value: t, label: PARTNER_TYPE_LABELS[t] })) },
          { key: "name", label: "Name", type: "text", placeholder: "e.g. SS-3 Nagpur Stockist" },
          { key: "city", label: "City", type: "text", placeholder: "City" },
          { key: "active", label: "Active", type: "bool" },
        ]}
      />
    </>
  );
}
