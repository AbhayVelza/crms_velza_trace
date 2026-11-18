"use client";

import Link from "next/link";
import { Reveal, RevealItem } from "@/components/motion";
import { MENU_ICONS } from "@/components/Sidebar";
import { IconArrowRight, IconInbox, IconPackage, IconPackageOpen, IconWarehouse } from "@/components/icons";
import { useSession } from "@/components/session";
import { Card, PageTitle, Stat } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { ROLE_LABELS } from "@/lib/core/types";
import { MENU } from "@/lib/menu";

/** Same /api/stock response the My stock page reads (only the counts are shown here). */
interface StockSummary {
  counts: { cases: number; trays: number; openedCases: number; openedTrays: number; loosePacks: number };
  incoming: unknown[];
}

export default function Home() {
  const { role, user, organisation } = useSession();
  // Roles with a "My stock" page see their live stock figures at the top of the overview.
  const hasStock = !!role && MENU[role].some((m) => m.href === "/stock");
  const { data: stock } = useApi<StockSummary>(hasStock ? "/api/stock" : null, { refreshOnChange: true });
  if (!role || !user) return null;

  return (
    <>
      <PageTitle eyebrow={ROLE_LABELS[role] + " portal"} title={`Welcome back, ${user.name.split(" ")[0]}`} subtitle={`Signed in as ${user.name} (${user.id}) · ${organisation}`} />

      {hasStock && stock && (
        <Reveal className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 lg:gap-5">
          <RevealItem>
            <Stat label="Cases here" value={stock.counts.cases} icon={IconPackage} hint={stock.counts.openedCases ? `${stock.counts.openedCases} opened` : undefined} />
          </RevealItem>
          <RevealItem>
            <Stat label="Trays here" value={stock.counts.trays} icon={IconWarehouse} hint={stock.counts.openedTrays ? `${stock.counts.openedTrays} opened` : undefined} />
          </RevealItem>
          <RevealItem>
            <Stat label="Loose packs" value={stock.counts.loosePacks} icon={IconPackageOpen} />
          </RevealItem>
          <RevealItem>
            <Stat label="Incoming" value={stock.incoming.length} icon={IconInbox} tone={stock.incoming.length ? "warn" : undefined} />
          </RevealItem>
        </Reveal>
      )}

      <h2 className="mb-3 text-[0.8125rem] font-semibold text-muted-foreground">Quick access</h2>
      <Reveal className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
        {MENU[role].map((m) => {
          const Icon = MENU_ICONS[m.href];
          return (
            <RevealItem key={m.href} className="h-full">
              <Link href={m.href} className="group block h-full rounded-card">
                <Card className="flex h-full flex-col transition-[border-color,box-shadow,transform] duration-300 ease-out group-hover:-translate-y-1 group-hover:border-brand-line group-hover:shadow-hover group-active:translate-y-0">
                  <div className="flex items-start justify-between gap-4">
                    {Icon && (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-brand-line bg-brand-soft text-brand transition-[background-color,color,transform] duration-300 ease-out group-hover:scale-105 group-hover:bg-primary group-hover:text-primary-foreground">
                        <Icon size={24} />
                      </span>
                    )}
                    <IconArrowRight size={20} className="mt-1 text-subtle-foreground transition-[transform,color] duration-300 ease-out group-hover:translate-x-1 group-hover:text-brand" />
                  </div>
                  <div className="mt-4">
                    <div className="text-lg font-bold leading-snug tracking-[-0.005em] text-foreground sm:text-[1.1875rem]">{m.label}</div>
                    <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted-foreground">{m.description}</p>
                  </div>
                </Card>
              </Link>
            </RevealItem>
          );
        })}
      </Reveal>
    </>
  );
}
