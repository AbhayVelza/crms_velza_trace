// Two OS processes allocating from one batch at the same moment — the deployment-level check of serial
// uniqueness. Never point it at real data: it RESETS the store it is given.
//
//   PostgreSQL (must be a throwaway database):
//     $env:STORE="postgres"; $env:DATABASE_URL="postgres://…/throwaway"; npx tsx tests/qa/serialMultiProcess.ts <outDir>
//   JSON (a throwaway file):
//     $env:STORE="json"; $env:VELZA_DB_PATH="<outDir>\db.json"; npx tsx tests/qa/serialMultiProcess.ts <outDir>
//
// Expected: PostgreSQL — both processes allocate, no lot handed to two requests, none lost; JSON — the
// second process is refused (the file belongs to one process), so nothing can be allocated twice.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { closeStores, getStore, storeKind } from "@/lib/store";
import { continueBatch, createPrintOrder } from "@/lib/services/printOrders";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

const [outDir, role, name, batchCode, startAt, n] = process.argv.slice(2);
type Response = { proc: string; status?: number | string; code?: string; lot?: string; orderId?: string };
const operatorId = async () => (await getStore().users.list({ role: "OPERATOR" }))[0].id;

async function worker() {
  const results: unknown[] = [];
  try {
    const op = await operatorId();
    await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
    await Promise.all(
      Array.from({ length: Number(n) }, async (_, i) => {
        try {
          const r = (await continueBatch(op, { batchCode, cases: 1, trays: 0, idempotencyKey: crypto.randomUUID() })) as { printOrder: { id: string; lotCodes: string[] } };
          results.push({ i, status: 200, orderId: r.printOrder.id, lot: r.printOrder.lotCodes[0] });
        } catch (e) {
          const err = e as { status?: number; code?: string; name?: string };
          results.push({ i, status: err.status ?? 500, code: err.code ?? err.name });
        }
      }),
    );
  } catch (e) {
    results.push({ status: "PROCESS_REFUSED", code: (e as Error).name, message: (e as Error).message.slice(0, 200) });
  }
  await fs.writeFile(path.join(outDir, `mp-${name}.json`), JSON.stringify(results, null, 1));
  await closeStores();
}

async function coordinator() {
  await fs.mkdir(outDir, { recursive: true });
  for (const f of await fs.readdir(outDir)) if (f.startsWith("mp-")) await fs.rm(path.join(outDir, f));
  await getStore().reset(buildSampleSeed());
  const r = (await createPrintOrder(await operatorId(), {
    idempotencyKey: crypto.randomUUID(),
    batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-11-01", cases: 1, trays: 0 }],
  })) as { printOrder: { batchCodes: string[] } };
  const batch = r.printOrder.batchCodes[0];
  await closeStores(); // the workers are separate processes (and the JSON file has one owner at a time)

  const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const start = Date.now() + 6000;
  const run = (w: string) =>
    new Promise<void>((resolve, reject) =>
      execFile(process.execPath, [tsx, "tests/qa/serialMultiProcess.ts", outDir, "worker", w, batch, String(start), "20"], { env: process.env }, (e) => (e ? reject(e) : resolve())),
    );
  await Promise.all([run("A"), run("B")]);

  const responses = (
    await Promise.all(["A", "B"].map(async (w) => (JSON.parse(await fs.readFile(path.join(outDir, `mp-${w}.json`), "utf8")) as Omit<Response, "proc">[]).map((x): Response => ({ ...x, proc: w }))))
  ).flat();
  const ok = responses.filter((x) => x.status === 200) as (Response & { lot: string; orderId: string })[];
  const s = await getStore().snapshot();
  const stored = new Set(s.lots.filter((l) => l.batchCode === batch).map((l) => l.lotCode));
  const all = [...s.lots.map((l) => l.lotCode), ...s.packs.map((p) => p.packCode)];
  const report = {
    store: storeKind(),
    requests: responses.length,
    succeeded: ok.length,
    refusedProcesses: responses.filter((x) => x.status === "PROCESS_REFUSED").map((x) => `${x.proc}: ${x.code}`),
    otherFailures: responses.filter((x) => x.status !== 200 && x.status !== "PROCESS_REFUSED").map((x) => `${x.status}:${x.code}`),
    lotHandedToTwoRequests: ok.length - new Set(ok.map((x) => x.lot)).size,
    acknowledgedButNotStored: ok.filter((x) => !stored.has(x.lot)).length,
    acknowledgedOrdersMissing: ok.filter((x) => !s.printOrders.some((o) => o.id === x.orderId)).length,
    lotsStoredForBatch: stored.size,
    batchNextLot: s.batches.find((b) => b.code === batch)?.nextLot,
    duplicateSerialsInStore: all.length - new Set(all).size,
  };
  console.log(JSON.stringify(report, null, 1));
  await fs.writeFile(path.join(outDir, `report-${storeKind()}.json`), JSON.stringify(report, null, 1));
  await closeStores();
}

void (role === "worker" ? worker() : coordinator());
