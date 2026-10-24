"use client";

import { AdminCrud } from "@/components/AdminCrud";
import { useSession } from "@/components/session";
import { PageTitle } from "@/components/ui";
import { ROLE_LABELS, ROLE_PARTNER_TYPE, ROLES, type Role } from "@/lib/core/types";

export default function UsersPage() {
  const { data } = useSession();
  const partners = data?.partners ?? [];
  return (
    <>
      <PageTitle title="Users" subtitle="Partner roles must belong to a partner of the matching tier; Velza Admin and Traceability Owner have none." />
      <AdminCrud
        entity="users"
        title="Users"
        sort={(a, b) => ROLES.indexOf(a.role as Role) - ROLES.indexOf(b.role as Role) || String(a.name).localeCompare(String(b.name))}
        columns={[
          { key: "name", label: "Name", type: "text", placeholder: "Full name" },
          { key: "role", label: "Role", type: "select", createOnly: true, options: () => ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
          {
            key: "partnerId",
            label: "Partner",
            type: "select",
            options: (row) => {
              const type = ROLE_PARTNER_TYPE[row.role as Role];
              const list = type ? partners.filter((p) => p.type === type) : [];
              return type ? list.map((p) => ({ value: p.id, label: p.name })) : [{ value: "", label: "— Velza HQ —" }];
            },
          },
          { key: "active", label: "Active", type: "bool" },
        ]}
      />
    </>
  );
}
