"use client";

import Link from "next/link";
import { useSession } from "@/components/session";
import { Card, PageTitle } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/core/types";
import { MENU } from "@/lib/menu";

export default function Home() {
  const { role, user, organisation } = useSession();
  if (!role || !user) return null;

  return (
    <>
      <PageTitle title={`${ROLE_LABELS[role]} portal`} subtitle={`Signed in as ${user.name} · ${organisation}`} />
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
