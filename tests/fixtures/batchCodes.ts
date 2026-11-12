// A fresh batch code on Velza Admin's list, for tests that create print orders (the operator now picks a batch
// code from that list; automatic pool codes are switched off).
import { getStore } from "@/lib/store";
import { ADMIN_CODE_DEVICE } from "@/lib/services/printOrders";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export async function freshBatchCode(): Promise<string> {
  const store = getStore();
  for (;;) {
    const code = Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");
    if ((await store.batchCodePool.list({ code })).length || (await store.batches.list({ code })).length) continue;
    await store.batchCodePool.create({ id: crypto.randomUUID(), code, deviceId: ADMIN_CODE_DEVICE, status: "RESERVED", issuedAt: new Date().toISOString(), usedAt: null });
    return code;
  }
}

const codeByKey = new Map<string, Promise<string>>();

/**
 * createPrintOrder with a batch code added when the body has none: a fresh one per order, and the same one
 * again for a retry with the same idempotency key (so replays still match).
 */
export function withBatchCode<B extends object, R>(fn: (user: string | null, body: B) => Promise<R>) {
  return async (user: string | null, body: B): Promise<R> => {
    const b = body as { batchCode?: unknown; idempotencyKey?: string };
    if (b.batchCode !== undefined) return fn(user, body);
    let code = b.idempotencyKey ? codeByKey.get(b.idempotencyKey) : undefined;
    if (!code) {
      code = freshBatchCode();
      if (b.idempotencyKey) codeByKey.set(b.idempotencyKey, code);
    }
    return fn(user, { ...body, batchCode: await code });
  };
}
