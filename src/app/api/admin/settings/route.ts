import { handler, jsonBody, userIdOf } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/services/admin";

export const GET = handler(() => getSettings());
export const PUT = handler(async (req) => updateSettings(userIdOf(req), await jsonBody(req)));
