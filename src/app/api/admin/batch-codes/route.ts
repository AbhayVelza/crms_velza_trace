import { handler, jsonBody, userIdOf } from "@/lib/api";
import { createBatchCode, listBatchCodes } from "@/lib/services/admin";

/** Velza Admin's batch codes (entered by hand): list, and add one `{ code }`. */
export const GET = handler((req) => listBatchCodes(userIdOf(req)));
export const POST = handler(async (req) => createBatchCode(userIdOf(req), await jsonBody(req)));
