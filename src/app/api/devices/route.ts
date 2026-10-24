import { handler, userIdOf } from "@/lib/api";
import { listDevices } from "@/lib/services/operator";

export const GET = handler((req) => listDevices(userIdOf(req)));
