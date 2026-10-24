import { z } from "zod";
import { handler, userIdOf } from "@/lib/api";
import { DEMO_SCREENS, demoCodes } from "@/lib/services/demo";

export const GET = handler(async (req) => {
  const params = new URL(req.url).searchParams;
  const screen = z.enum(DEMO_SCREENS).parse(params.get("screen"));
  return demoCodes(userIdOf(req), screen, params.get("lotCode") ?? undefined);
});
