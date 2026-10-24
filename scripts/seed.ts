// npm run seed            → reset data/db.json to the base seed
// npm run seed -- --demo  → base seed + one printed, packed batch partly moved down the chain

import { getStore, dbFilePath } from "@/lib/store";
import { buildBaseSeed } from "@/lib/store/seedData";
import { buildDemoData } from "@/lib/services/demoSeed";

async function main() {
  const demo = process.argv.includes("--demo");
  const store = getStore();
  await store.reset(buildBaseSeed());
  console.log(`Base seed written to ${dbFilePath()}`);
  if (demo) {
    const summary = await buildDemoData();
    console.log("Demo data:");
    for (const line of summary) console.log(`  - ${line}`);
  }
  const [partners, users, pool] = await Promise.all([store.partners.list(), store.users.list(), store.batchCodePool.list({ status: "RESERVED" })]);
  console.log(`${partners.length} partners, ${users.length} users, ${pool.length} reserved batch codes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
