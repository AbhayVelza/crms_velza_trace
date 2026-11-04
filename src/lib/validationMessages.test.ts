import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { NotFoundError } from "@/lib/store";
import { countLabel, lotRangeLabel } from "./format";
import { fieldLabel, friendlyValidation } from "./validationMessages";

const issues = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  if (r.success) throw new Error("expected a validation error");
  return friendlyValidation(r.error);
};

describe("friendly validation messages", () => {
  it("required and chosen fields", () => {
    const s = z.object({ manufacturerId: z.string().min(1), name: z.string().trim().min(1).max(60), role: z.enum(["A", "B"]) });
    // zod 4 reports a missing and a wrong choice the same way, so both read "Choose a valid …".
    expect(issues(s, { manufacturerId: "", name: "" }).message).toBe("Choose a manufacturer; Name is required; Choose a valid role");
    expect(issues(s, { manufacturerId: "x", name: "y", role: "Z" }).message).toBe("Choose a valid role");
    expect(issues(z.object({ phone: z.string() }), {}).message).toBe("Phone is required");
  });

  it("messages written in a schema are kept, without the field key in front", () => {
    const s = z.object({ contactPerson: z.string().trim().min(1, "Contact person is required") });
    expect(issues(s, { contactPerson: " " }).message).toBe("Contact person is required");
  });

  it("numbers, whole numbers and limits", () => {
    const s = z.object({ cases: z.number().int().min(0), notReceivedThresholdDays: z.number().min(0.01), name: z.string().max(5) });
    expect(issues(s, { cases: -1, notReceivedThresholdDays: 1, name: "a" }).message).toBe("Cases must be at least 0");
    expect(issues(s, { cases: 1.5, notReceivedThresholdDays: 1, name: "a" }).message).toBe("Cases must be a whole number");
    expect(issues(s, { cases: 1, notReceivedThresholdDays: -1, name: "a" }).message).toBe("Not-received alert (days) must be at least 0.01");
    expect(issues(s, { cases: 1, notReceivedThresholdDays: 1, name: "abcdefg" }).message).toBe("Name must be at most 5 characters");
  });

  it("nested and unknown fields get readable labels; field-level details are given", () => {
    expect(fieldLabel(["lotSticker", "widthMm"])).toBe("Lot sticker width (mm)");
    expect(fieldLabel(["someNewField"])).toBe("Some new field");
    const s = z.object({ lotSticker: z.object({ widthMm: z.number().min(30) }), idempotencyKey: z.uuid() });
    const r = issues(s, { lotSticker: { widthMm: 1 }, idempotencyKey: "x" });
    expect(r.fields).toEqual([
      { field: "lotSticker.widthMm", message: "Lot sticker width (mm) must be at least 30" },
      { field: "idempotencyKey", message: "Request key is not valid" },
    ]);
  });
});

describe("error responses sent to the browser", () => {
  it("validation: readable message, per-field details, no internal issue objects", async () => {
    const r = z.object({ manufacturerId: z.string().min(1) }).safeParse({ manufacturerId: "" });
    const res = errorResponse(r.error);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: { code: "VALIDATION", message: "Choose a manufacturer", details: [{ field: "manufacturerId", message: "Choose a manufacturer" }] } });
    expect(JSON.stringify(body)).not.toMatch(/too_small|origin|minimum|expected/);
  });

  it("store not-found: no internal table names", async () => {
    const res = errorResponse(new NotFoundError("lots 91ABCDEFOR00001"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "The requested record was not found" } });
  });

  it("unexpected errors: no message, stack or path", async () => {
    const res = errorResponse(new Error("ENOENT: C:\\secret\\path\\db.json"));
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(500);
    expect(text).not.toMatch(/ENOENT|secret|db\.json|at /);
  });
});

describe("text helpers", () => {
  it("countLabel uses the singular for one", () => {
    expect(countLabel(1, "retailer")).toBe("1 retailer");
    expect(countLabel(0, "retailer")).toBe("0 retailers");
    expect(countLabel(2, "distributor")).toBe("2 distributors");
    expect(countLabel(99987, "lot")).toBe("99,987 lots");
  });

  it("lotRangeLabel: one lot or a range", () => {
    expect(lotRangeLabel("00006", "00006")).toBe("Lot 00006");
    expect(lotRangeLabel("00004", "00006")).toBe("Lots 00004–00006");
  });
});
