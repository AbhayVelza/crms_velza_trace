import { Suspense } from "react";
import { PrintView } from "@/components/PrintView";
import { Loading } from "@/components/ui";

async function CodePrint({ params }: { params: PageProps<"/print/code/[code]">["params"] }) {
  const { code } = await params;
  return <PrintView path={`/api/stickers?code=${encodeURIComponent(code)}`} backHref="/operator/reprint" backLabel="Reprint" />;
}

/** Single-sticker print view used by Reprint (same code). */
export default function Page({ params }: PageProps<"/print/code/[code]">) {
  return (
    <Suspense fallback={<Loading />}>
      <CodePrint params={params} />
    </Suspense>
  );
}
