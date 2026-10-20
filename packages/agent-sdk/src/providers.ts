import type { AgentPackConnectionDescriptor, AgentPackDeclaredTool } from "./manifest.js";
import type {
  AgentExecutionContext,
  JsonSchema,
  RuntimeProviderOperation,
  RuntimeRecord,
  RuntimeResult,
  RuntimeToolBinding,
} from "./runtime.js";

/**
 * Bundled provider adapters. Each adapter is a pure mapping from a normalized
 * request to a brokered HTTP call (path and query under the connection
 * provider's configured endpoint) and from the vendor response back to a
 * normalized record. Packages compose the tool factories below into their own
 * control-plane module; hosts, client ids and credentials stay in the
 * environment's connection provider configuration.
 */

export type BrokeredRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path and query relative to the configured provider endpoint. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
};

export type MailMessage = {
  id: string;
  subject: string;
  from?: string;
  receivedAt?: string;
  preview?: string;
};

export type GeoPoint = { label: string; latitude: number; longitude: number };
export type RouteSummary = { distanceMeters: number; durationSeconds: number };
export type NewsArticle = {
  title: string;
  url: string;
  publishedAt?: string;
  source?: string;
  summary?: string;
};

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};

export type CalendarAdapterId = "google-calendar" | "microsoft-graph";
export type MailAdapterId = "gmail" | "microsoft-graph";
export type GeocodingAdapterId = "nominatim";
export type RoutingAdapterId = "osrm";
export type NewsAdapterId = "newsapi";

export const calendarAdapters: Record<
  CalendarAdapterId,
  {
    listEvents(input: { from: string; to: string; limit: number }): BrokeredRequest;
    parseEvents(body: unknown): CalendarEvent[];
    createEvent(input: {
      title: string;
      start: string;
      end: string;
      attendees: string[];
      location?: string;
    }): BrokeredRequest;
    parseCreated(body: unknown): { id: string };
  }
> = {
  "google-calendar": {
    listEvents: ({ from, to, limit }) => ({
      method: "GET",
      path: `calendars/primary/events${query({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: limit })}`,
    }),
    parseEvents: (body) =>
      list(record(body).items).map((item) => {
        const event = record(item);
        const start = record(event.start);
        const end = record(event.end);
        return {
          id: str(event.id) ?? "",
          title: str(event.summary) ?? "",
          start: str(start.dateTime) ?? str(start.date) ?? "",
          end: str(end.dateTime) ?? str(end.date) ?? "",
          ...(str(event.location) ? { location: str(event.location) } : {}),
          attendees: list(event.attendees)
            .map((attendee) => str(record(attendee).email))
            .filter((email): email is string => Boolean(email)),
        };
      }),
    createEvent: ({ title, start, end, attendees, location }) => ({
      method: "POST",
      path: "calendars/primary/events",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summary: title,
        start: { dateTime: start },
        end: { dateTime: end },
        ...(location ? { location } : {}),
        attendees: attendees.map((email) => ({ email })),
      }),
    }),
    parseCreated: (body) => ({ id: str(record(body).id) ?? "" }),
  },
  "microsoft-graph": {
    listEvents: ({ from, to, limit }) => ({
      method: "GET",
      path: `me/calendarView${query({ startDateTime: from, endDateTime: to, $top: limit, $orderby: "start/dateTime" })}`,
    }),
    parseEvents: (body) =>
      list(record(body).value).map((item) => {
        const event = record(item);
        const location = str(record(event.location).displayName);
        return {
          id: str(event.id) ?? "",
          title: str(event.subject) ?? "",
          start: str(record(event.start).dateTime) ?? "",
          end: str(record(event.end).dateTime) ?? "",
          ...(location ? { location } : {}),
          attendees: list(event.attendees)
            .map((attendee) => str(record(record(attendee).emailAddress).address))
            .filter((email): email is string => Boolean(email)),
        };
      }),
    createEvent: ({ title, start, end, attendees, location }) => ({
      method: "POST",
      path: "me/events",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: title,
        start: { dateTime: start, timeZone: "UTC" },
        end: { dateTime: end, timeZone: "UTC" },
        ...(location ? { location: { displayName: location } } : {}),
        attendees: attendees.map((email) => ({
          emailAddress: { address: email },
          type: "required",
        })),
      }),
    }),
    parseCreated: (body) => ({ id: str(record(body).id) ?? "" }),
  },
};

const base64Url = (value: string) =>
  btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const mailAdapters: Record<
  MailAdapterId,
  {
    listMessages(input: { query?: string; limit: number }): BrokeredRequest;
    parseMessages(body: unknown): MailMessage[];
    sendMessage(input: { to: string[]; subject: string; text: string }): BrokeredRequest;
    parseSent(body: unknown): { id: string };
  }
> = {
  gmail: {
    listMessages: ({ query: q, limit }) => ({
      method: "GET",
      path: `users/me/messages${query({ q, maxResults: limit })}`,
    }),
    // Gmail's list returns ids only; metadata needs a second call per message, which the tool makes.
    parseMessages: (body) =>
      list(record(body).messages).map((item) => ({ id: str(record(item).id) ?? "", subject: "" })),
    sendMessage: ({ to, subject, text }) => ({
      method: "POST",
      path: "users/me/messages/send",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        raw: base64Url(
          [
            `To: ${to.join(", ")}`,
            `Subject: ${subject}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            text,
          ].join("\r\n"),
        ),
      }),
    }),
    parseSent: (body) => ({ id: str(record(body).id) ?? "" }),
  },
  "microsoft-graph": {
    listMessages: ({ query: q, limit }) => ({
      method: "GET",
      path: `me/messages${query({ $search: q ? `"${q.replace(/"/g, "")}"` : undefined, $top: limit })}`,
    }),
    parseMessages: (body) =>
      list(record(body).value).map((item) => {
        const message = record(item);
        return {
          id: str(message.id) ?? "",
          subject: str(message.subject) ?? "",
          from: str(record(record(message.from).emailAddress).address),
          receivedAt: str(message.receivedDateTime),
          preview: str(message.bodyPreview),
        };
      }),
    sendMessage: ({ to, subject, text }) => ({
      method: "POST",
      path: "me/sendMail",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "Text", content: text },
          toRecipients: to.map((address) => ({ emailAddress: { address } })),
        },
      }),
    }),
    parseSent: () => ({ id: "accepted" }),
  },
};

export const geocodingAdapters: Record<
  GeocodingAdapterId,
  {
    search(input: { query: string; limit: number }): BrokeredRequest;
    parse(body: unknown): GeoPoint[];
  }
> = {
  nominatim: {
    search: ({ query: q, limit }) => ({
      method: "GET",
      path: `search${query({ q, format: "jsonv2", limit })}`,
    }),
    parse: (body) =>
      list(body)
        .map((item) => {
          const place = record(item);
          const latitude = num(place.lat);
          const longitude = num(place.lon);
          return latitude === undefined || longitude === undefined
            ? null
            : { label: str(place.display_name) ?? "", latitude, longitude };
        })
        .filter((point): point is GeoPoint => point !== null),
  },
};

export const routingAdapters: Record<
  RoutingAdapterId,
  {
    route(input: { from: GeoPoint; to: GeoPoint; profile?: string }): BrokeredRequest;
    parse(body: unknown): RouteSummary | null;
  }
> = {
  osrm: {
    route: ({ from, to, profile = "driving" }) => ({
      method: "GET",
      path: `route/v1/${profile}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}${query({ overview: "false" })}`,
    }),
    parse: (body) => {
      const route = record(list(record(body).routes)[0]);
      const distance = num(route.distance);
      const duration = num(route.duration);
      return distance === undefined || duration === undefined
        ? null
        : { distanceMeters: distance, durationSeconds: duration };
    },
  },
};

export const newsAdapters: Record<
  NewsAdapterId,
  {
    search(input: { query: string; from?: string; limit: number }): BrokeredRequest;
    parse(body: unknown): NewsArticle[];
  }
> = {
  newsapi: {
    search: ({ query: q, from, limit }) => ({
      method: "GET",
      path: `everything${query({ q, from, pageSize: limit, sortBy: "publishedAt" })}`,
    }),
    parse: (body) =>
      list(record(body).articles).map((item) => {
        const article = record(item);
        return {
          title: str(article.title) ?? "",
          url: str(article.url) ?? "",
          publishedAt: str(article.publishedAt),
          source: str(record(article.source).name),
          summary: str(article.description),
        };
      }),
  },
};

/** Transactional email as a reviewed provider operation; the relay-shaped `{to, subject, text}` request. */
export const transactionalEmailOperation = (input: {
  id?: string;
  version?: string;
  providerId: string;
  auth?: RuntimeProviderOperation["auth"];
  path?: string;
  /** Defaults to `defaultOutreachPolicy`; pass a higher cap deliberately, the platform never runs without one. */
  outreach?: RuntimeProviderOperation["outreach"];
}): RuntimeProviderOperation => ({
  outreach: { ...defaultOutreachPolicy, ...input.outreach },
  id: input.id ?? "email.send",
  version: input.version ?? "1",
  providerId: input.providerId,
  auth: input.auth ?? "bearer",
  method: "POST",
  path: input.path ?? "/messages",
  inputSchema: transactionalEmailSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["requestId", "messageId", "status"],
    properties: {
      requestId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      messageId: { type: "string", minLength: 1, maxLength: 200 },
      status: { type: "string", enum: ["queued", "sent", "rejected"] },
    },
  },
  timeoutMs: 10_000,
  maxResponseBytes: 16_384,
  receipt: {
    requestIdField: "requestId",
    referenceField: "messageId",
    statusField: "status",
    rejectedValues: ["rejected"],
  },
});

export const transactionalEmailSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to", "subject", "text"],
  properties: {
    to: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: { type: "string", pattern: "^[^\\s@]{1,64}@[^\\s@]{1,255}$" },
    },
    subject: { type: "string", minLength: 1, maxLength: 200 },
    text: { type: "string", minLength: 1, maxLength: 20_000 },
  },
};

/** Applied to every person-facing operation unless the pack raises it: a modest daily cap, no window. */
export const defaultOutreachPolicy: NonNullable<RuntimeProviderOperation["outreach"]> = {
  dailyCap: 50,
};

/** E.164 without spaces; the relay is responsible for opt-out lists and carrier rules. */
export const e164Pattern = "^\\+[1-9][0-9]{6,14}$";

export const smsMessageSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to", "text"],
  properties: {
    to: { type: "string", pattern: e164Pattern },
    text: { type: "string", minLength: 1, maxLength: 1600 },
  },
};

/**
 * One text message through the operator's SMS relay, which holds the carrier
 * credentials and the opt-out list and echoes `requestId`. Pair it with a tool
 * whose `action.providerOperation` names it; approval and receipts follow.
 */
export const smsSendOperation = (input: {
  id?: string;
  version?: string;
  providerId: string;
  auth?: RuntimeProviderOperation["auth"];
  path?: string;
  /** Defaults to `defaultOutreachPolicy`; pass a higher cap deliberately, the platform never runs without one. */
  outreach?: RuntimeProviderOperation["outreach"];
}): RuntimeProviderOperation => ({
  outreach: { ...defaultOutreachPolicy, ...input.outreach },
  id: input.id ?? "sms.send",
  version: input.version ?? "1",
  providerId: input.providerId,
  auth: input.auth ?? "bearer",
  method: "POST",
  path: input.path ?? "/sms",
  inputSchema: smsMessageSchema,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["requestId", "messageId", "status"],
    properties: {
      requestId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      messageId: { type: "string", minLength: 1, maxLength: 200 },
      status: { type: "string", enum: ["queued", "sent", "rejected", "opted_out"] },
    },
  },
  timeoutMs: 10_000,
  maxResponseBytes: 16_384,
  receipt: {
    requestIdField: "requestId",
    referenceField: "messageId",
    statusField: "status",
    rejectedValues: ["rejected", "opted_out"],
  },
});

type ReadToolOptions<Input extends RuntimeRecord, Output extends RuntimeRecord> = {
  id: string;
  connectionId: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  adapterVersion: string;
  modelVisible?: boolean;
  timeoutMs?: number;
  /** Returned, marked `source: "recorded"`, when the connection is not authorized. */
  recorded?: (input: Input) => Output;
  request: (input: Input) => BrokeredRequest;
  parse: (body: unknown, input: Input) => Output;
};

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

/**
 * A read-only inline tool over a brokered connection. The platform supplies the
 * endpoint and credential; the tool only shapes the request and the result.
 */
export const brokeredReadTool = <Input extends RuntimeRecord, Output extends RuntimeRecord>(
  options: ReadToolOptions<Input, Output>,
): RuntimeToolBinding => ({
  id: options.id,
  description: options.description,
  inputSchema: options.inputSchema,
  outputSchema: options.outputSchema,
  executionModes: ["dry_run"],
  transport: "cloudflare_inline",
  adapterVersion: options.adapterVersion,
  timeoutMs: options.timeoutMs ?? 15_000,
  maxArtifactBytes: 65_536,
  policy: {
    reference: `${options.id}.v1`,
    adminVisible: true,
    modelVisible: options.modelVisible ?? false,
    requiresApproval: false,
    policyEditable: true,
    mutationRisk: "read_only",
  },
  async execute(rawInput: RuntimeRecord, context: AgentExecutionContext): Promise<RuntimeResult> {
    const input = rawInput as Input;
    const capability = await context.connections.resolve(options.connectionId, options.id);
    if (capability.status !== "authorized" || !capability.request) {
      if (options.recorded)
        return {
          ok: true,
          output: { ...options.recorded(input), source: "recorded" },
          summary: `${options.id} returned the recorded sample; ${options.connectionId} is ${capability.status}.`,
        };
      return {
        ok: false,
        error: { code: "connection_not_authorized", message: capability.reason },
        summary: `${options.connectionId} is not authorized.`,
      };
    }
    const request = options.request(input);
    const response = await capability.request({
      url: `broker://configured/${request.path}`,
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    if (response.status < 200 || response.status >= 300)
      return {
        ok: false,
        error: {
          code: "provider_request_failed",
          message: `Provider returned ${response.status}.`,
        },
        summary: `${options.id} failed with status ${response.status}.`,
      };
    return {
      ok: true,
      output: { ...options.parse(parseJson(response.body), input), source: "live" },
      summary: `${options.id} completed.`,
    };
  },
});

const iso = { type: "string", minLength: 10, maxLength: 40 } as const;

/** Upcoming events between two instants from the connection's primary calendar. */
export const calendarReadTool = (input: {
  id?: string;
  connectionId: string;
  adapter: CalendarAdapterId;
  modelVisible?: boolean;
  recorded?: CalendarEvent[];
}): RuntimeToolBinding =>
  brokeredReadTool<{ from: string; to: string; limit?: number }, { events: CalendarEvent[] }>({
    id: input.id ?? "calendar.read",
    connectionId: input.connectionId,
    description: "List calendar events in a window.",
    adapterVersion: `${input.adapter}-v1`,
    modelVisible: input.modelVisible,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: { from: iso, to: iso, limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    outputSchema: { type: "object", required: ["events", "source"] },
    recorded: input.recorded ? () => ({ events: input.recorded ?? [] }) : undefined,
    request: ({ from, to, limit }) =>
      calendarAdapters[input.adapter].listEvents({ from, to, limit: limit ?? 50 }),
    parse: (body) => ({ events: calendarAdapters[input.adapter].parseEvents(body) }),
  });

/** Forward geocoding of a free-text place. */
export const geocodeTool = (input: {
  id?: string;
  connectionId: string;
  adapter?: GeocodingAdapterId;
  modelVisible?: boolean;
  recorded?: GeoPoint[];
}): RuntimeToolBinding =>
  brokeredReadTool<{ query: string; limit?: number }, { places: GeoPoint[] }>({
    id: input.id ?? "geo.geocode",
    connectionId: input.connectionId,
    description: "Resolve a place name or address to coordinates.",
    adapterVersion: `${input.adapter ?? "nominatim"}-v1`,
    modelVisible: input.modelVisible,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    outputSchema: { type: "object", required: ["places", "source"] },
    recorded: input.recorded ? () => ({ places: input.recorded ?? [] }) : undefined,
    request: ({ query: q, limit }) =>
      geocodingAdapters[input.adapter ?? "nominatim"].search({ query: q, limit: limit ?? 5 }),
    parse: (body) => ({ places: geocodingAdapters[input.adapter ?? "nominatim"].parse(body) }),
  });

/** Driving distance and duration between two points. */
export const routeTool = (input: {
  id?: string;
  connectionId: string;
  adapter?: RoutingAdapterId;
  modelVisible?: boolean;
  recorded?: RouteSummary;
}): RuntimeToolBinding =>
  brokeredReadTool<{ from: GeoPoint; to: GeoPoint }, { route: RouteSummary | null }>({
    id: input.id ?? "geo.route",
    connectionId: input.connectionId,
    description: "Estimate travel distance and time between two points.",
    adapterVersion: `${input.adapter ?? "osrm"}-v1`,
    modelVisible: input.modelVisible,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: { from: geoPointSchema, to: geoPointSchema },
    },
    outputSchema: { type: "object", required: ["route", "source"] },
    recorded: input.recorded ? () => ({ route: input.recorded ?? null }) : undefined,
    request: ({ from, to }) => routingAdapters[input.adapter ?? "osrm"].route({ from, to }),
    parse: (body) => ({ route: routingAdapters[input.adapter ?? "osrm"].parse(body) }),
  });

const geoPointSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "latitude", "longitude"],
  properties: {
    label: { type: "string", maxLength: 200 },
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
  },
};

/** Recent articles matching a query, optionally since a date. */
export const newsSearchTool = (input: {
  id?: string;
  connectionId: string;
  adapter?: NewsAdapterId;
  modelVisible?: boolean;
  recorded?: NewsArticle[];
}): RuntimeToolBinding =>
  brokeredReadTool<{ query: string; from?: string; limit?: number }, { articles: NewsArticle[] }>({
    id: input.id ?? "news.search",
    connectionId: input.connectionId,
    description: "Search recent news articles.",
    adapterVersion: `${input.adapter ?? "newsapi"}-v1`,
    modelVisible: input.modelVisible,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        from: iso,
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    outputSchema: { type: "object", required: ["articles", "source"] },
    recorded: input.recorded ? () => ({ articles: input.recorded ?? [] }) : undefined,
    request: ({ query: q, from, limit }) =>
      newsAdapters[input.adapter ?? "newsapi"].search({ query: q, from, limit: limit ?? 10 }),
    parse: (body) => ({ articles: newsAdapters[input.adapter ?? "newsapi"].parse(body) }),
  });

/** Recent mailbox messages matching a query. */
export const mailboxReadTool = (input: {
  id?: string;
  connectionId: string;
  adapter: MailAdapterId;
  modelVisible?: boolean;
  recorded?: MailMessage[];
}): RuntimeToolBinding =>
  brokeredReadTool<{ query?: string; limit?: number }, { messages: MailMessage[] }>({
    id: input.id ?? "mail.read",
    connectionId: input.connectionId,
    description: "List recent mailbox messages.",
    adapterVersion: `${input.adapter}-v1`,
    modelVisible: input.modelVisible,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    outputSchema: { type: "object", required: ["messages", "source"] },
    recorded: input.recorded ? () => ({ messages: input.recorded ?? [] }) : undefined,
    request: ({ query: q, limit }) =>
      mailAdapters[input.adapter].listMessages({ query: q, limit: limit ?? 20 }),
    parse: (body) => ({ messages: mailAdapters[input.adapter].parseMessages(body) }),
  });

/** Manifest descriptors that pair with the factories above. */
export const providerToolDescriptor = (
  tool: RuntimeToolBinding,
  purpose: string,
  options: { invocation?: AgentPackDeclaredTool["invocation"]; required?: boolean } = {},
): AgentPackDeclaredTool => ({
  id: tool.id,
  invocation: options.invocation ?? "workflow",
  required: options.required ?? false,
  executionModes: [...tool.executionModes],
  modelVisibleDefault: tool.policy.modelVisible,
  purpose,
});

export const providerConnectionDescriptor = (input: {
  id: string;
  provider: string;
  toolIds: string[];
  credentialClass: "api_key" | "oauth2";
  scopes?: string[];
  required?: boolean;
}): AgentPackConnectionDescriptor => ({
  id: input.id,
  provider: input.provider,
  principal: "user",
  credentialClass: input.credentialClass,
  custody: "external_broker",
  required: input.required ?? false,
  toolIds: input.toolIds,
  scopes: input.scopes ?? [],
});
