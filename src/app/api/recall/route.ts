import { handler, jsonBody, userIdOf } from "@/lib/api";
import { badRequest } from "@/lib/services/common";
import { recall, recallReport } from "@/lib/services/trace";

/** Recall report: GET /api/recall?batchCode=... */
export const GET = handler(async (req) => {
  const batchCode = new URL(req.url).searchParams.get("batchCode");
  if (!batchCode) throw badRequest("BATCH_REQUIRED", "batchCode is required");
  return recallReport(userIdOf(req), batchCode);
});
export const POST = handler(async (req) => recall(userIdOf(req), await jsonBody(req)));
