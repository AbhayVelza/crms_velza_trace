import { z } from "zod";
import { handler, userIdOf } from "@/lib/api";
import { notFound } from "@/lib/services/common";
import { DEMO_SCREENS, demoCodes } from "@/lib/services/demo";

// Same switch as the Demo helper in ScanInput: dev mode, or a build made with NEXT_PUBLIC_DEMO_HELPER=1.
// In a normal production build this route does not exist, so real codes can't be listed through it.
const ENABLED = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEMO_HELPER === "1";

export const GET = handler(async (req) => {
  if (!ENABLED) throw notFound("Not found");
  const params = new URL(req.url).searchParams;
  const screen = z.enum(DEMO_SCREENS).parse(params.get("screen"));
  return demoCodes(userIdOf(req), screen, params.get("lotCode") ?? undefined);
});
