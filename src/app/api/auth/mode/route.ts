import { handler } from "@/lib/api";
import { signInRequired } from "@/lib/signInMode";

/** Whether a password is needed (false while developing: pick who to act as instead). */
export const GET = handler(async () => ({ signInRequired: signInRequired() }));
