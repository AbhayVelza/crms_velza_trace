import { handler, jsonBody, userIdOf } from "@/lib/api";
import { changePassword } from "@/lib/services/auth";

/** `{currentPassword, newPassword}`: change your own password. */
export const POST = handler(async (req) => changePassword(userIdOf(req), await jsonBody(req)));
