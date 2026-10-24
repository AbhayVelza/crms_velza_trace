// Optional demo data (npm run seed -- --demo), built through the real services so every
// movement and scan is in the ledger exactly as if done in the UI.

import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { dispatch, receive } from "./movement";
import { createPrintOrder, markPrinted } from "./printOrders";
import { verify } from "./verify";

async function userFor(role: Role, partnerPrefix?: string) {
  const store = getStore();
  const [users, partners] = await Promise.all([store.users.list({ role }), store.partners.list()]);
  const user = users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix));
  if (!user) throw new Error(`No ${role} user${partnerPrefix ? ` at ${partnerPrefix}` : ""}`);
  return user;
}

async function partnerId(prefix: string) {
  const p = (await getStore().partners.list()).find((x) => x.name.startsWith(prefix));
  if (!p) throw new Error(`No partner ${prefix}`);
  return p.id;
}

export async function buildDemoData(): Promise<string[]> {
  const operator = await userFor("OPERATOR");
  const qc = await userFor("QC");
  const ss1 = await userFor("SS", "SS-1");
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const expiry = new Date(today);
  expiry.setMonth(expiry.getMonth() + 9);

  const created = await createPrintOrder(operator.id, {
    batches: [{ flavour: "MN", mfgDate: iso(today), expiryDate: iso(expiry), cases: 3, trays: 1 }],
  });
  if (created.preview) throw new Error("unexpected preview");
  const order = created.printOrder;
  await markPrinted(operator.id, order.id);

  const store = getStore();
  for (const lotCode of order.lotCodes) {
    const packs = (await store.packs.list({ lotCode })).map((p) => p.packCode);
    await verify(qc.id, { action: "scanLot", code: lotCode });
    for (const [i, code] of packs.entries()) await verify(qc.id, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
    await verify(qc.id, { action: "confirm", lotCode, packCodes: packs });
  }

  const [c1, c2, c3] = order.lotCodes;
  await dispatch(operator.id, { action: "confirm", toPartnerId: await partnerId("SS-1"), invoice: "INV-DEMO-1", codes: [c1, c2, c3] });
  await receive(ss1.id, { code: c1 });
  await receive(ss1.id, { code: c2 });
  await dispatch(ss1.id, { action: "confirm", toPartnerId: await partnerId("DB-1"), invoice: "INV-DEMO-2", codes: [c2] });

  return [
    `Batch ${order.batchCodes[0]} (Mango): 3 cases + 1 tray, printed and verified`,
    `${c1} at SS-1`,
    `${c2} in transit SS-1 → DB-1 (INV-DEMO-2)`,
    `${c3} in transit Manufacturer → SS-1 (INV-DEMO-1)`,
    `${order.lotCodes[3]} (tray) packed at the manufacturer`,
  ];
}
