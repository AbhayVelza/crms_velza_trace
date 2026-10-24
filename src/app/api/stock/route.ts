import { handler, userIdOf } from "@/lib/api";
import { myStock } from "@/lib/services/trace";

export const GET = handler((req) => myStock(userIdOf(req)));
