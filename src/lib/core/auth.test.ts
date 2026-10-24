import { describe, expect, it } from "vitest";
import { accountStatus, canSignIn, checkLoginId, checkPassword, needsApproval, normalizeLoginId } from "./auth";
import type { Role } from "./types";

const acct = (role: Role, over: Partial<Parameters<typeof accountStatus>[0]> = {}) => ({
  role,
  active: true,
  hasPassword: true,
  adminApprovedAt: null,
  hqApprovedAt: null,
  rejectedAt: null,
  ...over,
});

describe("account approval", () => {
  it("partner roles need Admin + HQ approval; Velza staff don't", () => {
    for (const r of ["OPERATOR", "QC", "SS", "DB", "SUPPLIER", "OUTLET"] as Role[]) expect(needsApproval(r)).toBe(true);
    expect(needsApproval("ADMIN")).toBe(false);
    expect(needsApproval("TRACE_OWNER")).toBe(false);
  });

  it("walks Admin → HQ → approved", () => {
    expect(accountStatus(acct("SS"))).toBe("PENDING_ADMIN");
    expect(accountStatus(acct("SS", { adminApprovedAt: "t" }))).toBe("PENDING_HQ");
    expect(canSignIn(acct("SS", { adminApprovedAt: "t" }))).toBe(false);
    expect(accountStatus(acct("SS", { adminApprovedAt: "t", hqApprovedAt: "t" }))).toBe("APPROVED");
    expect(canSignIn(acct("SS", { adminApprovedAt: "t", hqApprovedAt: "t" }))).toBe(true);
  });

  it("HQ approval alone is not enough", () => {
    expect(canSignIn(acct("DB", { hqApprovedAt: "t" }))).toBe(false);
  });

  it("rejected, disabled and password-less accounts can't sign in", () => {
    expect(accountStatus(acct("SS", { adminApprovedAt: "t", rejectedAt: "t" }))).toBe("REJECTED");
    expect(accountStatus(acct("SS", { adminApprovedAt: "t", hqApprovedAt: "t", active: false }))).toBe("DISABLED");
    expect(accountStatus(acct("ADMIN", { hasPassword: false }))).toBe("NO_PASSWORD");
    expect(canSignIn(acct("ADMIN"))).toBe(true);
    expect(canSignIn(acct("TRACE_OWNER", { active: false }))).toBe(false);
  });
});

describe("sign-in ID and password policy", () => {
  it("normalizes and validates sign-in IDs", () => {
    expect(normalizeLoginId("  SS1.Pune ")).toBe("ss1.pune");
    expect(checkLoginId("ss1.pune")).toBeNull();
    expect(checkLoginId("ab")).not.toBeNull();
    expect(checkLoginId("has space")).not.toBeNull();
  });

  it("requires 8+ characters with letters and digits", () => {
    expect(checkPassword("Velza@2026")).toBeNull();
    expect(checkPassword("short1")).toMatch(/at least 8/);
    expect(checkPassword("onlyletters")).toMatch(/letters and digits/);
    expect(checkPassword("12345678")).toMatch(/letters and digits/);
  });
});
