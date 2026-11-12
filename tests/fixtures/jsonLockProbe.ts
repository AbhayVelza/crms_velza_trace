// Child process for the JSON single-process lock test: opens the JSON store at VELZA_DB_PATH and prints
// one JSON line — {"ok":true} if it could read and write, or {"ok":false,"error":...} — then exits.
import { closeStores, getStore } from "@/lib/store";

async function main() {
  try {
    const store = getStore();
    await store.transaction(async (tx) => tx.getSettings());
    console.log(JSON.stringify({ ok: true, pid: process.pid }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: (e as Error).name, message: (e as Error).message }));
  } finally {
    await closeStores();
  }
}
void main();
