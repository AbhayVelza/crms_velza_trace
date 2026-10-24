import { Suspense } from "react";
import { PrintView } from "@/components/PrintView";

async function CodePrint({ params }: { params: PageProps<"/print/code/[code]">["params"] }) {
  const { code } = await params;
  return <PrintView path={`/api/stickers?code=${encodeURIComponent(code)}`} backHref="/operator/reprint" backLabel="Reprint" />;
}

/** Single-sticker print view used by Reprint (same code). */
export default function Page({ params }: PageProps<"/print/code/[code]">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <CodePrint params={params} />
    </Suspense>
  );
}
