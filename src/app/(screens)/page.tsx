"use client";

import Link from "next/link";
import { MENU_ICONS } from "@/components/Sidebar";
import { IconArrowRight } from "@/components/icons";
import { useSession } from "@/components/session";
import { Card, PageTitle } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/core/types";
import { MENU } from "@/lib/menu";

export default function Home() {
  const { role, user, organisation } = useSession();
  if (!role || !user) return null;

  return (
    <>
      <PageTitle title={`${ROLE_LABELS[role]} portal`} subtitle={`Signed in as ${user.name} (${user.id}) · ${organisation}`} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
        {MENU[role].map((m) => {
          const Icon = MENU_ICONS[m.href];
          return (
            <Link key={m.href} href={m.href} className="group rounded-card">
              <Card className="flex h-full flex-col transition-[border-color,box-shadow,transform] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:border-foreground/30 group-hover:shadow-pop group-active:translate-y-0">
                <div className="flex items-start justify-between gap-4">
                  {Icon && (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2 text-foreground transition-colors duration-200 ease-out group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon size={24} />
                    </span>
                  )}
                  <IconArrowRight size={20} className="mt-1 text-subtle-foreground transition-[transform,color] duration-200 ease-out group-hover:translate-x-1 group-hover:text-foreground" />
                </div>
                <div className="mt-4">
                  <div className="text-lg font-bold leading-snug tracking-[-0.005em] text-foreground sm:text-[1.1875rem]">{m.label}</div>
                  <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted-foreground">{m.description}</p>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}
