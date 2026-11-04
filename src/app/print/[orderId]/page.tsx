import { Suspense } from "react";
import { PrintView } from "@/components/PrintView";
import { Loading } from "@/components/ui";

async function OrderPrint({ params }: { params: PageProps<"/print/[orderId]">["params"] }) {
  const { orderId } = await params;
  return <PrintView path={`/api/print-orders/${encodeURIComponent(orderId)}`} backHref="/operator/orders" backLabel="Print orders" />;
}

export default function Page({ params }: PageProps<"/print/[orderId]">) {
  return (
    <Suspense fallback={<Loading />}>
      <OrderPrint params={params} />
    </Suspense>
  );
}
