import { Suspense } from "react";
import { PrintView } from "@/components/PrintView";

async function OrderPrint({ params }: { params: PageProps<"/print/[orderId]">["params"] }) {
  const { orderId } = await params;
  return <PrintView path={`/api/print-orders/${encodeURIComponent(orderId)}`} backHref="/operator/orders" backLabel="Print orders" />;
}

export default function Page({ params }: PageProps<"/print/[orderId]">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <OrderPrint params={params} />
    </Suspense>
  );
}
