import { handler, jsonBody, userIdOf } from "@/lib/api";
import { alertPage, alerts, updateAlert } from "@/lib/services/trace";

const PAGE_PARAMS = ["state", "type", "limit", "offset"];

/**
 * GET /api/alerts — every alert (newest first, with its state), as before.
 * GET /api/alerts?state=OPEN|ACKNOWLEDGED|CLOSED|ALL&type=…&limit=…&offset=… — one page: { items, total, counts }.
 */
export const GET = handler((req) => {
  const params = new URL(req.url).searchParams;
  if (!PAGE_PARAMS.some((p) => params.has(p))) return alerts(userIdOf(req));
  return alertPage(userIdOf(req), Object.fromEntries(PAGE_PARAMS.filter((p) => params.has(p)).map((p) => [p, params.get(p)])));
});

/** POST /api/alerts { alertId, action: ACKNOWLEDGE | CLOSE | REOPEN, note? } — HQ only. */
export const POST = handler(async (req) => updateAlert(userIdOf(req), await jsonBody(req)));
