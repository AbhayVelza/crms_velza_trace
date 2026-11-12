import { handler, userIdOf } from "@/lib/api";
import { listBatchCodesForPrint } from "@/lib/services/printOrders";

/** The batch codes the operator can pick in the print wizard, with the flavours each already has. */
export const GET = handler((req) => listBatchCodesForPrint(userIdOf(req)));
