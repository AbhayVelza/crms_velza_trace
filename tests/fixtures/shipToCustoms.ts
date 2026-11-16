// The plant ships to Customs only inside a shipping container (since 16 Nov 2026). Tests that need stock at
// Customs (or beyond) use this: create a container, load the lots, dispatch it to Customs, receive it there with
// one scan of its number and — unless clear is false — clear it, so the lots are AT_WAREHOUSE (ready for an SS).

import { clearContainer, createContainer, dispatchContainer, loadContainer } from "@/lib/services/containers";
import { receive } from "@/lib/services/movement";

let counter = 0;

export async function shipToCustoms(opts: {
  operatorId: string;
  customsUserId: string;
  customsId: string;
  lotCodes: string[];
  invoice: string;
  containerCode?: string;
  /** Receive at Customs (default true). With false the container stays IN_TRANSIT. */
  receive?: boolean;
  /** Clear at Customs after receiving (default true). With false the lots stay held AT_CUSTOMS. */
  clear?: boolean;
}): Promise<string> {
  const code = opts.containerCode ?? `TCSU${String(++counter).padStart(7, "0")}`;
  const { container } = await createContainer(opts.operatorId, { code });
  for (const lot of opts.lotCodes) {
    const r = await loadContainer(opts.operatorId, container.id, { code: lot });
    if (!r.ok) throw new Error(`shipToCustoms: ${lot} could not be loaded: ${r.message}`);
  }
  await dispatchContainer(opts.operatorId, container.id, { toPartnerId: opts.customsId, invoice: opts.invoice });
  if (opts.receive === false) return container.id;
  const r = await receive(opts.customsUserId, { code });
  if (!r.ok) throw new Error(`shipToCustoms: container ${code} not received: ${r.message}`);
  if (opts.clear !== false) await clearContainer(opts.customsUserId, container.id, {});
  return container.id;
}
