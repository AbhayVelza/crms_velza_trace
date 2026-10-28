import Link from "next/link";
import { Suspense } from "react";
import { GeneratedCodes } from "@/components/GeneratedCodes";
import { IconPrinter } from "@/components/icons";
import { Loading, PageTitle } from "@/components/ui";

async function OrderCodes({ params }: { params: PageProps<"/operator/orders/[id]">["params"] }) {
  const { id } = await params;
  return (
    <>
      <PageTitle
        title="Codes of a print order"
        subtitle="Every sticker with every field saved for it, as stored in the codes table."
        actions={
          <Link className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line-strong bg-surface px-5 text-sm font-semibold text-foreground transition-colors duration-150 hover:bg-muted" href={`/print/${encodeURIComponent(id)}`}>
            <IconPrinter size={17} />
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
    <Suspense fallback={<Loading />}>
      <OrderCodes params={params} />
    </Suspense>
  );
}
