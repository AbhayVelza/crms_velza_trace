import { handler } from "@/lib/api";
import { health } from "@/lib/services/health";

/** { ok: true } when this process reaches its database (or data file), else 503 { ok: false }. No sign-in. */
export const GET = handler(() => health());
