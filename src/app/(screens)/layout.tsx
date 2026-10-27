import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { RoleGate } from "@/components/RoleGate";
import { SessionProvider } from "@/components/session";

// The header and the role gate read the URL (usePathname). On a page with an ID in its URL
// (/operator/orders/<id>) that is only known at request time, so they sit in Suspense boundaries.
export default function ScreensLayout({ children }: LayoutProps<"/">) {
  return (
    <SessionProvider>
      <Suspense fallback={<div className="h-14 border-b border-slate-200 bg-white print:hidden" />}>
        <AppHeader />
      </Suspense>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
          <RoleGate>{children}</RoleGate>
        </Suspense>
      </main>
    </SessionProvider>
  );
}
