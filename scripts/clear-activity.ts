// npm run clear-activity → delete all activity (batches, print orders, lots, packs, movements,
// scans, reprints) but keep the setup: countries, flavours, partners, sign-ins, sessions, devices,
// batch code pool, ID sequences and settings, exactly as they are.

import { dbFilePath, describeStore, getStore } from "@/lib/store";

async function main() {
  const store = getStore();
  const data = await store.snapshot();
  await store.reset({ ...data, batches: [], printOrders: [], lots: [], packs: [], movements: [], scans: [], reprints: [] });
  console.log(`Cleared ${data.batches.length} batches, ${data.lots.length} lots, ${data.movements.length} movements, ${data.scans.length} scans in ${describeStore() ?? dbFilePath()}`);
  console.log(
    `Kept ${data.partners.length} partners, ${data.users.length} sign-ins, ${data.devices.length} device(s), ` +
      `${data.batchCodePool.filter((p) => p.status === "RESERVED").length} reserved batch codes (used ones stay used), settings`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
