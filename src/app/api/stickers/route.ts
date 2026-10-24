import { handler, userIdOf } from "@/lib/api";
import { badRequest } from "@/lib/services/common";
import { stickerForReprint } from "@/lib/services/printOrders";

/** Single sticker for a reprint: GET /api/stickers?code=... */
export const GET = handler(async (req) => {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) throw badRequest("CODE_REQUIRED", "code is required");
  return stickerForReprint(userIdOf(req), code);
});
