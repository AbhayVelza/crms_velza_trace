// A container scan at Customs must not look its container up again for every case/tray in it: with up to 2,860 lots
// per container and every past container searched each time, one scan would cost lots × containers (final review
// of 16 Nov 2026). The lookup is counted by wrapping it; behaviour is unchanged.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { createContainer, dispatchContainer, loadContainer } from "@/lib/services/containers";
import * as customs from "@/lib/services/customs";
import { receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

vi.mock("@/lib/services/customs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/customs")>();
  return { ...actual, containerOfLot: vi.fn(actual.containerOfLot) };
});

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();

async function containerOnTheWay(number: string, cases: number) {
  const r = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases, trays: 0 }] });
  if (r.preview) throw new Error("expected an order");
  await markPrinted(ids.operator, r.printOrder.id);
  for (const lotCode of r.printOrder.lotCodes) {
    const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
  }
  const { container } = await createContainer(ids.operator, { code: number });
  for (const lot of r.printOrder.lotCodes) await loadContainer(ids.operator, container.id, { code: lot });
  await dispatchContainer(ids.operator, container.id, { toPartnerId: ids.VW, invoice: `INV-${number}` });
  return r.printOrder.lotCodes;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-customs-scale-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  const [users, partners] = await Promise.all([store().users.list(), store().partners.list()]);
  const user = (role: Role) => users.find((u) => u.role === role)!.id;
  Object.assign(ids, { operator: user("OPERATOR"), qc: user("QC"), vw: user("WAREHOUSE") });
  ids.VW = partners.find((p) => p.type === "WAREHOUSE")!.id;
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Customs receive cost", () => {
  it("a container scan does not look the container up once per case (it already knows it)", async () => {
    await containerOnTheWay("SCLU0000001", 3);
    const lookup = vi.mocked(customs.containerOfLot);
    lookup.mockClear();
    expect(await receive(ids.vw, { code: "SCLU0000001" })).toMatchObject({ ok: true, status: "AT_CUSTOMS", container: { received: 3 } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a single case scan looks its container up once", async () => {
    const [lot] = await containerOnTheWay("SCLU0000002", 1);
    const lookup = vi.mocked(customs.containerOfLot);
    lookup.mockClear();
    expect(await receive(ids.vw, { code: lot })).toMatchObject({ ok: true, status: "AT_CUSTOMS" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
