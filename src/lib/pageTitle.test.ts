import { describe, expect, it } from "vitest";
import { APP_TITLE, titleFor } from "./pageTitle";

describe("titleFor", () => {
  it("names each screen after its menu label", () => {
    expect(titleFor("/receive")).toBe(`Receive · ${APP_TITLE}`);
    expect(titleFor("/hq/alerts")).toBe(`Alerts · ${APP_TITLE}`);
    expect(titleFor("/")).toBe(`Overview · ${APP_TITLE}`);
  });

  it("uses the closest parent for detail pages", () => {
    expect(titleFor("/operator/orders/abc-123")).toBe(`Print orders · ${APP_TITLE}`);
    expect(titleFor("/hq")).toBe(`Dashboard · ${APP_TITLE}`);
  });

  it("falls back to the app name", () => {
    expect(titleFor("/nowhere")).toBe(APP_TITLE);
  });
});
