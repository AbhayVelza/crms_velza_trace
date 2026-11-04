// Print-order state as the operator should read it: codes generated → printing pending → printed (with time).
// Only the operator's "Mark as printed" in the print view moves an order to Printed; QC can verify its lots only then.

import type { PrintOrder } from "@/lib/core/types";
import { fmtTime, Pill } from "./ui";

/** Shared wording for where browser printing and CSV exports stand. */
export const PRINT_CONFIRMATION_NOTE =
  "Print only opens the browser print dialog; it records nothing, and neither do Ctrl+P or downloading the codes CSV. When every sticker has printed correctly, press Mark as printed in the print view — QC cannot verify the lots until then.";

export function PrintOrderStatus({ order, detail = true }: { order: Pick<PrintOrder, "status" | "printedAt">; detail?: boolean }) {
  if (order.status === "PRINTED") {
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <Pill tone="strong" dot>
          PRINTED
        </Pill>
        {detail && order.printedAt && <span className="text-xs text-muted-foreground">{fmtTime(order.printedAt)}</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Pill tone="warn" dot>
        PRINTING PENDING
      </Pill>
      {detail && <span className="text-xs text-muted-foreground">Codes generated, not marked printed</span>}
    </span>
  );
}
