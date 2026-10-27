// Writes the test sample network into the e2e store (run by global-setup), then closes it so the
// server can open the same database.
import { closeStores, describeStore, getStore } from "@/lib/store";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

getStore()
  .reset(buildSampleSeed())
  .then(() => console.log(`e2e sample network written to ${describeStore()}`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeStores);
