// npm run clear-activity → delete all activity (batches, print orders, lots, packs, movements,
// scans, reprints) but keep the setup: countries, flavours, partners, users (with passwords and
// approvals), devices, batch code pool, settings and sessions, exactly as they are.

import { dbFilePath, getStore } from "@/lib/store";
import type { DbSnapshot } from "@/lib/store";

async function main() {
  const store = getStore();
  const [countries, flavours, partners, users, devices, batchCodePool, settings, batches, lots, movements, scans] = await Promise.all([
    store.countries.list(),
    store.flavours.list(),
    store.partners.list(),
    store.users.list(),
    store.devices.list(),
    store.batchCodePool.list(),
    store.getSettings(),
    store.batches.list(),
    store.lots.list(),
    store.movements.list(),
    store.scans.list(),
  ]);
  // Sessions are kept too, so nobody is signed out.
  const sessions = await store.sessions.list();
  const snapshot: DbSnapshot = {
    countries,
    flavours,
    partners,
    users,
    devices,
    // USED codes stay so a batch code is never handed out twice.
    batchCodePool,
    settings: [settings],
    batches: [],
    printOrders: [],
    lots: [],
    packs: [],
    movements: [],
    scans: [],
    reprints: [],
    sessions,
  };
  await store.reset(snapshot);
  console.log(`Cleared ${batches.length} batches, ${lots.length} lots, ${movements.length} movements, ${scans.length} scans in ${dbFilePath()}`);
  console.log(`Kept ${partners.length} partners, ${users.length} users, ${devices.length} device(s), ${batchCodePool.filter((p) => p.status === "RESERVED").length} reserved batch codes, settings`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
