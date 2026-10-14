import { describe, expect, it } from "vitest";
import {
  calendarAdapters,
  calendarReadTool,
  geocodingAdapters,
  mailAdapters,
  newsAdapters,
  routingAdapters,
  transactionalEmailOperation,
} from "./providers.js";
import type { AgentExecutionContext, ConnectionCapability } from "./runtime.js";

const context = (capability: ConnectionCapability) =>
  ({ connections: { resolve: async () => capability } }) as unknown as AgentExecutionContext;

describe("bundled provider adapters", () => {
  it("shapes calendar requests and normalizes both vendors to one event record", () => {
    const window = { from: "2026-10-15T00:00:00Z", to: "2026-10-16T00:00:00Z", limit: 10 };
    const google = calendarAdapters["google-calendar"].listEvents(window);
    expect(google).toMatchObject({ method: "GET" });
    expect(google.path).toMatch(/^calendars\/primary\/events\?timeMin=.*&singleEvents=true/);
    const graph = calendarAdapters["microsoft-graph"].listEvents(window);
    expect(graph.path).toMatch(/^me\/calendarView\?startDateTime=.*%24top=10/);
    expect(
      calendarAdapters["google-calendar"].parseEvents({
        items: [
          {
            id: "g1",
            summary: "Inspection",
            start: { dateTime: "2026-10-15T09:00:00Z" },
            end: { dateTime: "2026-10-15T10:00:00Z" },
            location: "12 Elm St",
            attendees: [{ email: "a@example.test" }, { displayName: "no email" }],
          },
        ],
      }),
    ).toEqual([
      {
        id: "g1",
        title: "Inspection",
        start: "2026-10-15T09:00:00Z",
        end: "2026-10-15T10:00:00Z",
        location: "12 Elm St",
        attendees: ["a@example.test"],
      },
    ]);
    expect(
      calendarAdapters["microsoft-graph"].parseEvents({
        value: [
          {
            id: "m1",
            subject: "Quote",
            start: { dateTime: "2026-10-15T13:00:00" },
            end: { dateTime: "2026-10-15T13:30:00" },
            attendees: [{ emailAddress: { address: "b@example.test" } }],
          },
        ],
      }),
    ).toEqual([
      {
        id: "m1",
        title: "Quote",
        start: "2026-10-15T13:00:00",
        end: "2026-10-15T13:30:00",
        attendees: ["b@example.test"],
      },
    ]);
    const created = calendarAdapters["microsoft-graph"].createEvent({
      title: "Visit",
      start: "2026-10-16T09:00:00Z",
      end: "2026-10-16T10:00:00Z",
      attendees: ["c@example.test"],
    });
    expect(JSON.parse(created.body!)).toMatchObject({
      subject: "Visit",
      attendees: [{ emailAddress: { address: "c@example.test" } }],
    });
  });

  it("shapes mail, geocoding, routing and news requests without naming hosts", () => {
    const send = mailAdapters.gmail.sendMessage({
      to: ["x@example.test"],
      subject: "Hi",
      text: "Body",
    });
    expect(send.path).toBe("users/me/messages/send");
    expect(JSON.parse(send.body!).raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      mailAdapters["microsoft-graph"].parseMessages({
        value: [
          {
            id: "1",
            subject: "S",
            from: { emailAddress: { address: "f@example.test" } },
            bodyPreview: "p",
          },
        ],
      }),
    ).toEqual([
      { id: "1", subject: "S", from: "f@example.test", receivedAt: undefined, preview: "p" },
    ]);
    expect(geocodingAdapters.nominatim.search({ query: "12 Elm St", limit: 3 }).path).toBe(
      "search?q=12+Elm+St&format=jsonv2&limit=3",
    );
    expect(
      geocodingAdapters.nominatim.parse([
        { lat: "51.5", lon: "-0.1", display_name: "London" },
        { lat: "x" },
      ]),
    ).toEqual([{ label: "London", latitude: 51.5, longitude: -0.1 }]);
    const from = { label: "a", latitude: 51.5, longitude: -0.1 };
    const to = { label: "b", latitude: 51.6, longitude: -0.2 };
    expect(routingAdapters.osrm.route({ from, to }).path).toBe(
      "route/v1/driving/-0.1,51.5;-0.2,51.6?overview=false",
    );
    expect(routingAdapters.osrm.parse({ routes: [{ distance: 1200, duration: 300 }] })).toEqual({
      distanceMeters: 1200,
      durationSeconds: 300,
    });
    expect(routingAdapters.osrm.parse({ routes: [] })).toBeNull();
    expect(newsAdapters.newsapi.search({ query: "hail", from: "2026-10-01", limit: 5 }).path).toBe(
      "everything?q=hail&from=2026-10-01&pageSize=5&sortBy=publishedAt",
    );
    expect(
      newsAdapters.newsapi.parse({
        articles: [{ title: "T", url: "https://n.example/a", source: { name: "N" } }],
      }),
    ).toEqual([
      {
        title: "T",
        url: "https://n.example/a",
        publishedAt: undefined,
        source: "N",
        summary: undefined,
      },
    ]);
    for (const [adapter, request] of Object.entries({
      google: calendarAdapters["google-calendar"].listEvents({ from: "a", to: "b", limit: 1 }),
      gmail: send,
      news: newsAdapters.newsapi.search({ query: "q", limit: 1 }),
    }))
      expect(request.path, adapter).not.toMatch(/^https?:/);
  });

  it("declares transactional email as a reviewed provider operation", () => {
    const operation = transactionalEmailOperation({ providerId: "transactional-email" });
    expect(operation).toMatchObject({
      id: "email.send",
      providerId: "transactional-email",
      method: "POST",
      path: "/messages",
      receipt: { requestIdField: "requestId", statusField: "status", rejectedValues: ["rejected"] },
    });
    expect(Object.keys(operation.outputSchema.properties as object)).toEqual([
      "requestId",
      "messageId",
      "status",
    ]);
  });

  it("returns the recorded sample without a connection and the live result through the broker", async () => {
    const recorded = [{ id: "r1", title: "Recorded", start: "a", end: "b", attendees: [] }];
    const tool = calendarReadTool({
      connectionId: "calendar.primary",
      adapter: "google-calendar",
      recorded,
    });
    const offline = await tool.execute!(
      { from: "2026-10-15T00:00:00Z", to: "2026-10-16T00:00:00Z" },
      context({ id: "calendar.primary", status: "authorization_required", reason: "not yet" }),
    );
    expect(offline).toMatchObject({ ok: true, output: { events: recorded, source: "recorded" } });
    const calls: { url: string; method?: string }[] = [];
    const live = await tool.execute!(
      { from: "2026-10-15T00:00:00Z", to: "2026-10-16T00:00:00Z", limit: 2 },
      context({
        id: "calendar.primary",
        status: "authorized",
        reason: "ok",
        request: async (input) => {
          calls.push({ url: input.url, method: input.method });
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              items: [
                {
                  id: "l1",
                  summary: "Live",
                  start: { date: "2026-10-15" },
                  end: { date: "2026-10-15" },
                },
              ],
            }),
          };
        },
      }),
    );
    expect(calls).toEqual([
      {
        url: "broker://configured/calendars/primary/events?timeMin=2026-10-15T00%3A00%3A00Z&timeMax=2026-10-16T00%3A00%3A00Z&singleEvents=true&orderBy=startTime&maxResults=2",
        method: "GET",
      },
    ]);
    expect(live).toMatchObject({
      ok: true,
      output: {
        source: "live",
        events: [{ id: "l1", title: "Live", start: "2026-10-15", attendees: [] }],
      },
    });
    const failed = await tool.execute!(
      { from: "a", to: "b" },
      context({
        id: "calendar.primary",
        status: "authorized",
        reason: "ok",
        request: async () => ({ status: 503, headers: {}, body: "" }),
      }),
    );
    expect(failed).toMatchObject({ ok: false, error: { code: "provider_request_failed" } });
    const noFixture = calendarReadTool({
      connectionId: "calendar.primary",
      adapter: "microsoft-graph",
    });
    expect(
      await noFixture.execute!(
        { from: "a", to: "b" },
        context({ id: "calendar.primary", status: "unhealthy", reason: "down" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "connection_not_authorized" } });
  });
});
