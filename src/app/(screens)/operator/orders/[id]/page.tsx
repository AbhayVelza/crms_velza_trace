import Link from "next/link";
import { Suspense } from "react";
import { GeneratedCodes } from "@/components/GeneratedCodes";
import { PageTitle } from "@/components/ui";

async function OrderCodes({ params }: { params: PageProps<"/operator/orders/[id]">["params"] }) {
  const { id } = await params;
  return (
    <>
      <PageTitle
        title="Codes of a print order"
        subtitle="Every sticker with every field saved for it, as stored in the codes table."
        actions={
          <Link className="text-sm font-medium text-teal-800 hover:underline" href={`/print/${encodeURIComponent(id)}`}>
            Print view
          </Link>
        }
      />
      <GeneratedCodes printOrderId={id} />
    </>
  );
}

export default function Page({ params }: PageProps<"/operator/orders/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <OrderCodes params={params} />
    </Suspense>
  );
}
