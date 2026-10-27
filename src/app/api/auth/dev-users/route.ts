import { handler } from "@/lib/api";
import { devUsers } from "@/lib/services/auth";

/** While sign-in is off: everyone who can be acted as (404 when sign-in is on). */
export const GET = handler(async () => devUsers());
