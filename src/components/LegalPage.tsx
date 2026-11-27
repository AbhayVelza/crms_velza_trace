import Link from "next/link";
import type { ReactNode } from "react";
import { VelzaLogo } from "@/components/brand";
import { LegalLinks } from "@/components/LegalLinks";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { LEGAL } from "@/lib/legal";

/** Public layout for /privacy, /cookies and /terms: readable width, real headings, no sign-in needed. */
export function LegalPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-6">
        <Link href="/" aria-label="Velza Traceability home">
          <VelzaLogo height={40} className="h-10 w-auto" />
        </Link>
        <ThemeSwitcher />
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <article className="legal-prose space-y-4 text-[0.9375rem] leading-relaxed text-foreground">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            Version {LEGAL.version} · in force from {LEGAL.effectiveDate}
          </p>
          <div className="text-base">{intro}</div>
          {children}
        </article>
      </main>
      <footer className="border-t border-line px-4 py-6">
        <LegalLinks />
      </footer>
    </div>
  );
}

/** A titled section of a legal page. */
export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 pt-4">
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}
