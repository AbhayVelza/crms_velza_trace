// A database lock wait that runs out (55P03 lock_not_available: velza_app's lock_timeout of 10 s in deploy/roles_v11.sql)
// is answered as 409 "busy, try again", like the other "someone else holds these rows" outcomes, not as a 500.

import { describe, expect, it, vi } from "vitest";
import { errorResponse } from "./api";

describe("API errors: database lock timeout", () => {
  it("55P03 becomes 409 BUSY (nothing was committed, retrying is safe)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const e = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    const res = errorResponse(e);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "BUSY", message: expect.stringContaining("try again") } });
  });

  it("other database errors stay 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(errorResponse(Object.assign(new Error("boom"), { code: "XX000" })).status).toBe(500);
  });
});
