import { handler, jsonBody, sessionTokenOf, userIdOf } from "@/lib/api";
import { changePassword } from "@/lib/services/auth";

/** `{currentPassword, newPassword}`: change your own password (your other sessions are signed out). */
export const POST = handler(async (req) => changePassword(userIdOf(req), sessionTokenOf(req), await jsonBody(req)));
