"use client";

import type { ReactNode } from "react";
import { VelzaLogo, VelzaSymbol } from "@/components/brand";
import { LegalLinks } from "@/components/LegalLinks";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";

/** Sign-in / sign-up layout (`wide` for the longer sign-up form): black brand panel (wide screens) beside the form; the logo sits above the form on phones. */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex flex-1">
      <aside className="theme-dark brand-bar relative hidden w-[42%] max-w-xl flex-col justify-between overflow-hidden bg-surface p-12 text-foreground lg:flex">
        {/* A faint red glow from the corner, then the V as a tonal, cropped watermark (brand book p. 7 and 19). */}
        <div aria-hidden="true" className="pointer-events-none absolute -left-40 -top-40 h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(closest-side,rgb(230_33_23/0.18),transparent)]" />
        <VelzaSymbol height={520} tone="on-dark" className="pointer-events-none absolute -bottom-24 -right-40 h-[520px] w-auto max-w-none opacity-[0.07]" />
        <VelzaLogo height={128} tone="on-dark" className="relative h-32 w-auto self-start" />
        <div className="relative space-y-3">
          <span aria-hidden="true" className="block h-[3px] w-10 rounded-full bg-primary" />
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Velza Traceability</p>
          <p className="max-w-sm text-[1.75rem] font-bold leading-snug tracking-tight">Every case, tray and pack — from plant to retailer.</p>
          <p className="text-xs uppercase tracking-[0.16em] text-subtle-foreground">Driven by passion, defined by luxury</p>
        </div>
      </aside>
      <div className="relative flex flex-1 flex-col items-center justify-center bg-background px-4 py-10">
        <ThemeSwitcher className="absolute right-4 top-4" />
        <div className={`w-full ${wide ? "max-w-2xl" : "max-w-sm"} animate-rise-in`}>
          <div className="mb-8 flex justify-center lg:hidden">
            <VelzaLogo height={88} className="h-[88px] w-auto" />
          </div>
          <div className="rounded-card border border-line bg-surface p-6 shadow-pop sm:p-8">{children}</div>
          <LegalLinks className="mt-6" />
        </div>
      </div>
    </main>
  );
}
