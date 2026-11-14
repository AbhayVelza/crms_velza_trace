import { handler } from "@/lib/api";
import { stickerByCodeRefused } from "@/lib/services/printOrders";

/** Retired: a single sticker is printed only through a logged reprint (POST /api/reprint/<id>/stickers). Always 410. */
export const GET = handler(async () => stickerByCodeRefused());
