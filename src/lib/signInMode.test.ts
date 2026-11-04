import { afterEach, describe, expect, it, vi } from "vitest";
import { devDefaultUserId, devLogin, devUsers } from "@/lib/services/auth";
import { signInRequired } from "./signInMode";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mode(nodeEnv: string, signIn: string | undefined) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  if (signIn === undefined) vi.stubEnv("SIGN_IN", undefined as unknown as string);
  else vi.stubEnv("SIGN_IN", signIn);
  return signInRequired();
}

describe("signInRequired", () => {
  it("development: SIGN_IN=off turns sign-in off, SIGN_IN=on turns it on, unset is off", () => {
    expect(mode("development", "off")).toBe(false);
    expect(mode("development", "on")).toBe(true);
    expect(mode("development", undefined)).toBe(false);
    expect(mode("development", " ON ")).toBe(true);
  });

  it("production always requires sign-in: SIGN_IN=off is ignored, on and unset require it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mode("production", "off")).toBe(true);
    expect(mode("production", "OFF")).toBe(true);
    expect(mode("production", "on")).toBe(true);
    expect(mode("production", undefined)).toBe(true);
    expect(mode("production", "anything")).toBe(true);
  });

  it("production with SIGN_IN=off closes every sign-in bypass", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SIGN_IN", "off");
    // No default Velza Admin for requests without a session, and no act-as.
    expect(await devDefaultUserId()).toBeNull();
    await expect(devLogin({ userId: "AD0001" })).rejects.toMatchObject({ status: 404 });
    await expect(devUsers()).rejects.toMatchObject({ status: 404 });
  });
});
