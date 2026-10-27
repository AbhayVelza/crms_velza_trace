// npm run seed → reset the active store (data/db.json, or the database when DATABASE_URL is set) to a
// clean start: country 91, the four flavours, default settings, and two sign-ins — Velza Admin (AD0001)
// and Velza HQ (HQ0001). Their passwords come from VELZA_ADMIN_PASSWORD / VELZA_HQ_PASSWORD, or are
// generated and shown once here. Everything else is entered in the app (Admin portal).

import { closeStores, describeStore, getStore } from "@/lib/store";
import { ADMIN_LOGIN_ID, buildBaseSeed, HQ_LOGIN_ID, staffPasswords } from "@/lib/store/seedData";

async function main() {
  const passwords = staffPasswords();
  await getStore().reset(buildBaseSeed(passwords));
  console.log(`Clean data written to ${describeStore()}`);
  console.log(`  Velza Admin: sign-in ${ADMIN_LOGIN_ID}, password ${passwords.admin}`);
  console.log(`  Velza HQ:    sign-in ${HQ_LOGIN_ID}, password ${passwords.hq}`);
  console.log("Change both after the first sign-in (Account page). Register partners in the Admin portal.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeStores);
