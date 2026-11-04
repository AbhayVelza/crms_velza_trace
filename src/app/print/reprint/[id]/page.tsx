import { Suspense } from "react";
import { PrintView } from "@/components/PrintView";
import { Loading } from "@/components/ui";

async function ReprintPrint({ params }: { params: PageProps<"/print/reprint/[id]">["params"] }) {
  const { id } = await params;
  return <PrintView oncePath={`/api/reprint/${encodeURIComponent(id)}/stickers`} backHref="/operator/reprint" backLabel="Reprint" />;
}

/** Print view of one logged reprint: the sticker is served once. */
export default function Page({ params }: PageProps<"/print/reprint/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <ReprintPrint params={params} />
    </Suspense>
  );
}
