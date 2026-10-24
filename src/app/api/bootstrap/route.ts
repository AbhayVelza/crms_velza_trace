import { handler } from "@/lib/api";
import { bootstrap } from "@/lib/services/admin";

export const GET = handler(() => bootstrap());
