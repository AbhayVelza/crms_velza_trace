import { LEGAL, LEGAL_LINKS } from "@/lib/legal";

/** Privacy · Cookies · Terms, shown under the sign-in, sign-up and public QR pages and at the foot of the app. */
export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    // A plain div, not <nav>: it sits in a <footer> landmark where one exists, and the sidebar stays the only nav.
    <div data-testid="legal-links" className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground print:hidden ${className}`}>
      {LEGAL_LINKS.map((l) => (
        <a key={l.href} href={l.href} className="underline-offset-2 hover:text-foreground hover:underline">
          {l.label}
        </a>
      ))}
      {/* No computed year: pages using this are prerendered, and new Date() would break that. */}
      <span>© {LEGAL.business.tradingName}</span>
    </div>
  );
}
