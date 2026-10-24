"use client";

import Link from "next/link";
import { useSession } from "@/components/session";
import { Card, PageTitle } from "@/components/ui";
import { ROLE_LABELS, ROLES } from "@/lib/core/types";
import { MENU } from "@/lib/menu";

const ROLE_HINTS: Record<(typeof ROLES)[number], string> = {
  ADMIN: "Partners, users, devices, code lists, batch code pools, settings",
  OPERATOR: "Create print orders, print stickers, dispatch, reprint, void, sync",
  QC: "Verify each lot against its pasted pack stickers",
  SS: "Super Stockist: receive from manufacturer, dispatch to distributors",
  DB: "Distributor: receive from SS, dispatch to suppliers",
  SUPPLIER: "Receive, open lots, dispatch to outlets",
  OUTLET: "Receive and open lots",
  TRACE_OWNER: "Velza HQ: dashboard, search, alerts, recall",
};

export default function Home() {
  const { role, user, setRole } = useSession();

  if (!role || !user) {
    return (
      <>
        <PageTitle title="Velza Barcode Traceability" subtitle="Prototype — pick a role to act as. There is no login yet." />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map((r) => (
            <button key={r} type="button" onClick={() => setRole(r)} className="rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-teal-600">
              <div className="font-semibold text-slate-900">{ROLE_LABELS[r]}</div>
              <div className="mt-1 text-sm text-slate-600">{ROLE_HINTS[r]}</div>
            </button>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle title={ROLE_LABELS[role]} subtitle={`Signed in as ${user.name}`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MENU[role].map((m) => (
          <Link key={m.href} href={m.href}>
            <Card className="h-full hover:border-teal-600">
              <div className="font-semibold text-teal-800">{m.label}</div>
              <p className="mt-1 text-sm text-slate-600">{m.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
