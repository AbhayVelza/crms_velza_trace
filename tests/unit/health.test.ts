// GET /api/health: { ok: true } when the store answers, 503 { ok: false } when it doesn't or is too slow; no sign-in,
// nothing but `ok` in the body (no version, host, error text or schema). Runs on the JSON store and on PostgreSQL.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getStore } from "@/lib/store";
import { health } from "@/lib/services/health";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

// handler() calls next/server's connection(), which needs a real request scope; the rest of the wrapper runs as is.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-health-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await getStore().reset(buildSampleSeed());
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

const get = async () => {
  const { GET } = await import("@/app/api/health/route");
  return GET(new Request("http://localhost/api/health"), undefined);
};

describe("GET /api/health", () => {
  it("answers { ok: true } without signing in, never cached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("a store that fails gives 503 { ok: false }; the reason goes only to the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(getStore(), "ping").mockRejectedValue(new Error('connect ECONNREFUSED db.internal:5432 (relation "codes", schema v10)'));
    const res = await get();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false });
    expect(text).not.toMatch(/ECONNREFUSED|db\.internal|5432|codes|v10/);
    expect(log.mock.calls.flat().join(" ")).toMatch(/health check failed: connect ECONNREFUSED/);
  });

  it("a store that doesn't answer in time counts as down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(getStore(), "ping").mockReturnValue(new Promise(() => {}));
    const res = await health(50);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("the store's own ping reaches it (SELECT 1 / the data file)", async () => {
    await expect(getStore().ping()).resolves.toBeUndefined();
  });
});
