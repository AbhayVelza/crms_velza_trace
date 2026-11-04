"use client";

import { useApi } from "@/components/useApi";
import { Card, Empty, Notice, PageTitle, Table, Td } from "@/components/ui";
import { assignedPluralOf } from "@/lib/core/rules";
import { PARTNER_TYPE_LABELS, type Partner, type PartnerType } from "@/lib/core/types";

interface Data {
  me: Partner;
  childTypes: PartnerType[];
  partners: (Partner & { lotsInStock: number; loosePacksInStock: number; onTheWayFromMe: number })[];
}

export default function MyPartnersPage() {
  const { data, error } = useApi<Data>("/api/my-partners", { refreshOnChange: true });
  const plural = (data && assignedPluralOf(data.me.type)) || "partners";
  // A Super Stockist has distributors and retailers assigned directly to it: show which tier each row is.
  const tiers = data?.childTypes ?? [];
  const showTier = tiers.length > 1;
  const nameHead = tiers.length === 1 ? PARTNER_TYPE_LABELS[tiers[0]] : "Partner";
  return (
    <>
      <PageTitle title={`My ${plural}`} subtitle={data ? `${data.me.name} (${data.me.id}) · ${data.me.state || data.me.city}` : undefined} />
      {error && <Notice tone="error">{error}</Notice>}
      <Card title={`Assigned to you by Velza Admin (${data?.partners.length ?? 0})`}>
        <Table
          head={[nameHead, ...(showTier ? ["Tier"] : []), "ID", "Place", "Contact", "Lots in stock", "Loose packs", "On the way from you"]}
          empty={data?.partners.length ? null : <Empty>No {plural} assigned yet — ask Velza Admin</Empty>}
        >
          {data?.partners.map((p) => (
            <tr key={p.id}>
              <Td>
                {p.name}
                {!p.active && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}
              </Td>
              {showTier && <Td>{PARTNER_TYPE_LABELS[p.type]}</Td>}
              <Td className="font-mono text-xs">{p.id}</Td>
              <Td>
                {p.place}, {p.city}
              </Td>
              <Td className="text-xs">
                {p.contactPerson}
                <div className="text-muted-foreground">{p.phone}</div>
              </Td>
              <Td>{p.lotsInStock}</Td>
              <Td>{p.loosePacksInStock}</Td>
              <Td>{p.onTheWayFromMe}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
