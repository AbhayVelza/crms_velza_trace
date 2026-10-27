import { describe, expect, it } from "vitest";
import { clientIp, isCrossSiteWrite, RateLimiter } from "./security";

const h = (o: Record<string, string>) => new Headers(o);

describe("RateLimiter", () => {
  it("allows up to the limit per window, then says how long to wait", () => {
    const rl = new RateLimiter(3, 60_000);
    expect([rl.take("a", 0), rl.take("a", 0), rl.take("a", 0)]).toEqual([0, 0, 0]);
    expect(rl.take("a", 10_000)).toBe(50);
    expect(rl.take("b", 10_000)).toBe(0); // other clients unaffected
    expect(rl.take("a", 60_000)).toBe(0); // new window
  });

  it("keeps memory bounded under a flood of distinct keys", () => {
    const rl = new RateLimiter(1, 60_000, 100);
    for (let i = 0; i < 1000; i++) rl.take(`ip${i}`, 0);
    expect((rl as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(100);
  });
});

describe("clientIp", () => {
  it("uses the trusted proxy header when configured, so X-Forwarded-For can't be faked", () => {
    const headers = h({ "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "203.0.113.9" });
    expect(clientIp(headers, "cf-connecting-ip")).toBe("203.0.113.9");
    expect(clientIp(headers, undefined)).toBe("6.6.6.6");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }), undefined)).toBe("1.1.1.1");
    expect(clientIp(h({}), undefined)).toBe("unknown");
  });
});

describe("isCrossSiteWrite", () => {
  it("refuses writes from other sites, allows same-site pages and non-browser clients", () => {
    expect(isCrossSiteWrite("POST", h({ "sec-fetch-site": "cross-site", host: "app.velza.in" }))).toBe(true);
    expect(isCrossSiteWrite("POST", h({ origin: "https://evil.example", host: "app.velza.in" }))).toBe(true);
    expect(isCrossSiteWrite("POST", h({ "sec-fetch-site": "same-origin", origin: "https://app.velza.in", host: "app.velza.in" }))).toBe(false);
    expect(isCrossSiteWrite("POST", h({ host: "app.velza.in" }))).toBe(false);
    expect(isCrossSiteWrite("GET", h({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isCrossSiteWrite("DELETE", h({ origin: "not a url", host: "app.velza.in" }))).toBe(true);
  });
});
