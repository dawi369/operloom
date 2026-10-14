import { describe, expect, it } from "vitest";
import { resolveConfiguredUrl } from "./connection-broker-port";

describe("configured provider endpoint resolution", () => {
  it("joins adapter paths onto the configured endpoint and never lets a package pick a host", () => {
    expect(resolveConfiguredUrl("https://api.example/calendar/v3/", "broker://configured")).toBe(
      "https://api.example/calendar/v3/",
    );
    expect(
      resolveConfiguredUrl(
        "https://api.example/calendar/v3",
        "broker://configured/calendars/primary/events?x=1",
      ),
    ).toBe("https://api.example/calendar/v3/calendars/primary/events?x=1");
    expect(resolveConfiguredUrl(undefined, "broker://configured/a")).toBeUndefined();
    expect(resolveConfiguredUrl("https://api.example/v1", "https://other.example/x")).toBe(
      "https://other.example/x",
    );
    expect(resolveConfiguredUrl("https://api.example/v1", "broker://configured/../../etc")).toBe(
      "https://api.example/etc",
    );
  });
});
