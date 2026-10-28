import type { Metadata } from "next";
import { Suspense } from "react";
import { PublicLookup } from "./PublicLookup";

export const metadata: Metadata = { title: "Velza product check" };

async function Lookup({ params }: { params: PageProps<"/t/[code]">["params"] }) {
  const { code } = await params;
  return <PublicLookup code={decodeURIComponent(code)} />;
}

/** What a QR scan opens. Safe fields only: no partners, invoices or history. */
export default function Page({ params }: PageProps<"/t/[code]">) {
  return (
    <main className="flex flex-1 items-start justify-center bg-background px-4 py-10 sm:py-16">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Checking…</p>}>
        <Lookup params={params} />
      </Suspense>
    </main>
  );
}
