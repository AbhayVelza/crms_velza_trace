import { handler, jsonBody, userIdOf } from "@/lib/api";
import { createContainer, listContainers } from "@/lib/services/containers";

/** Shipping containers plant → Velza Warehouse that the signed-in user may see. */
export const GET = handler((req) => listContainers(userIdOf(req)));
/** `{ code }`: open a container for loading, by the container's own number (operator). */
export const POST = handler(async (req) => createContainer(userIdOf(req), await jsonBody(req)));
