import Link from "next/link";
import { Suspense } from "react";
import { Code, Loading, Notice } from "@/components/ui";

async function CodeNotice({ params }: { params: PageProps<"/print/code/[code]">["params"] }) {
  const { code } = await params;
  return (
    <div className="space-y-3">
      <Notice tone="info">
        Single stickers are printed only through Reprint. Log the reprint of <Code>{code}</Code> with its reason; each logged reprint prints once.
      </Notice>
      <Link href="/operator/reprint" className="text-sm font-semibold underline">
        Go to Reprint
      </Link>
    </div>
  );
}

/** Retired direct "print any code" view: points to Reprint, which logs the reason and prints once. */
export default function Page({ params }: PageProps<"/print/code/[code]">) {
  return (
    <Suspense fallback={<Loading />}>
      <CodeNotice params={params} />
    </Suspense>
  );
}
