"use client";

import { AdminCrud, type Row } from "@/components/AdminCrud";
import { useSession } from "@/components/session";
import { Button, cx, Notice, PageTitle } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import type { AccountStatus } from "@/lib/core/auth";
import { ROLE_LABELS, ROLE_PARTNER_TYPE, ROLES, type Role } from "@/lib/core/types";

const STATUS_TONE: Record<AccountStatus, string> = {
  APPROVED: "bg-green-100 text-green-800",
  PENDING_ADMIN: "bg-amber-100 text-amber-900",
  PENDING_HQ: "bg-amber-100 text-amber-900",
  REJECTED: "bg-red-100 text-red-800",
  NO_PASSWORD: "bg-slate-200 text-slate-700",
  DISABLED: "bg-slate-200 text-slate-600",
};

function StatusCell({ row }: { row: Row }) {
  const status = row.status as AccountStatus;
  return (
    <div className="min-w-[9rem]">
      <span className={cx("inline-block rounded px-2 py-0.5 text-xs font-medium", STATUS_TONE[status])}>{String(row.statusLabel)}</span>
      {status === "REJECTED" && row.rejectReason ? <div className="mt-1 text-xs text-red-700">“{String(row.rejectReason)}” — {String(row.rejectedByName)}</div> : null}
      {status === "APPROVED" && row.hqApprovedByName ? <div className="mt-1 text-xs text-slate-500">HQ: {String(row.hqApprovedByName)}</div> : null}
    </div>
  );
}

export default function UsersPage() {
  const { data } = useSession();
  const partners = data?.partners ?? [];
  return (
    <>
      <PageTitle
        title="Users & sign-in"
        subtitle="Set each person's sign-in ID and password. Partner accounts can sign in once Velza HQ approves them; Velza Admin and Velza HQ accounts need no approval."
      />
      <AdminCrud
        entity="users"
        title="Users"
        intro={
          <Notice tone="info">
            Adding a partner account counts as your (Admin) approval; it then waits in Velza HQ&apos;s <b>Account approvals</b>. Changing a
            user&apos;s role or partner sends the account back to HQ. Users can change their own password under <b>Account</b>.
          </Notice>
        }
        sort={(a, b) => ROLES.indexOf(a.role as Role) - ROLES.indexOf(b.role as Role) || String(a.name).localeCompare(String(b.name))}
        columns={[
          { key: "name", label: "Name", type: "text", placeholder: "Full name" },
          { key: "loginId", label: "Sign-in ID", type: "text", placeholder: "e.g. ss3.nagpur" },
          { key: "password", label: "Password", type: "password", placeholder: "8+ chars, letters + digits" },
          { key: "role", label: "Role / portal", type: "select", createOnly: true, options: () => ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
          {
            key: "partnerId",
            label: "Partner",
            type: "select",
            nullable: true,
            visible: (row) => !!ROLE_PARTNER_TYPE[row.role as Role],
            options: (row) => {
              const type = ROLE_PARTNER_TYPE[row.role as Role];
              return partners.filter((p) => p.type === type).map((p) => ({ value: p.id, label: p.name }));
            },
          },
          { key: "status", label: "Status", type: "display", render: (row) => <StatusCell row={row} /> },
          { key: "active", label: "Active", type: "bool" },
        ]}
        rowActions={(row, { reload, setMsg }) =>
          row.status === "REJECTED" ? (
            <Button
              variant="secondary"
              className="min-h-8 px-2 py-1 text-xs"
              onClick={async () => {
                try {
                  await api("/api/approvals", { body: { userId: row.id, action: "resubmit" } });
                  setMsg({ tone: "ok", text: `${row.name} sent to Velza HQ for approval again` });
                  await reload();
                } catch (e) {
                  setMsg({ tone: "error", text: errorText(e) });
                }
              }}
            >
              Send to HQ again
            </Button>
          ) : null
        }
      />
    </>
  );
}
