import { z } from "zod";
import { handler, jsonBody, userIdOf } from "@/lib/api";
import { issuePoolCodes, listPools } from "@/lib/services/admin";

const issueSchema = z.object({ deviceId: z.string(), count: z.number().int().optional() });

export const GET = handler((req) => listPools(userIdOf(req)));
export const POST = handler(async (req) => {
  const { deviceId, count } = issueSchema.parse(await jsonBody(req));
  return issuePoolCodes(userIdOf(req), deviceId, count);
});
