import { describe, expect, it } from "vitest";

import { resolveChannelTransport, type ChannelMessage } from "./notification-channels";
import {
  createResendEmailTransport,
  renderEmailParts,
  splitEmailTransport,
} from "./notification-email-resend";
import type { Env } from "./types";

const message: ChannelMessage = {
  channel: "email",
  address: "crew@example.test",
  title: "Memory suggestion",
  body: "Line one <b>\nstill one\n\nLine two",
  data: { eventType: "memory.proposed", targetType: "memory", targetId: "m-1", route: "memory" },
};

const fetcher = (status: number, body: unknown = { id: "re_123" }) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
};

describe("Resend email transport", () => {
  it("posts a text and HTML email with an idempotency key and maps the ticket", async () => {
    const { fn, calls } = fetcher(200);
    const transport = createResendEmailTransport(
      { apiKey: "re_key", from: "Operloom <notify@example.test>", replyTo: "ops@example.test" },
      { consoleOrigin: "https://console.example.test/", fetcher: fn },
    );
    expect(await transport.send(message)).toEqual({ ok: true, ticketId: "resend:re_123" });
    const [call] = calls;
    expect(call!.url).toBe("https://api.resend.com/emails");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_key");
    expect(headers["idempotency-key"]).toBe("memory.proposed:m-1:crew@example.test");
    const payload = JSON.parse(String(call!.init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      from: "Operloom <notify@example.test>",
      to: ["crew@example.test"],
      reply_to: "ops@example.test",
      subject: "Memory suggestion",
    });
    expect(payload.text).toContain("https://console.example.test/?open=memory&record=m-1");
    expect(payload.html).toContain("<p>Line one &#60;b&#62;<br>still one</p><p>Line two</p>");
    expect(payload.html).not.toContain("<b>");
  });

  it("retries on 429 and 5xx only, and refuses non-email channels", async () => {
    const send = async (status: number) =>
      createResendEmailTransport(
        { apiKey: "k", from: "a@b.test" },
        { fetcher: fetcher(status).fn },
      ).send(message);
    expect(await send(429)).toEqual({ ok: false, code: "resend_http_429", retryable: true });
    expect(await send(503)).toEqual({ ok: false, code: "resend_http_503", retryable: true });
    expect(await send(422)).toEqual({ ok: false, code: "resend_http_422", retryable: false });
    const unreachable = createResendEmailTransport(
      { apiKey: "k", from: "a@b.test" },
      {
        fetcher: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      },
    );
    expect(await unreachable.send(message)).toEqual({
      ok: false,
      code: "resend_unreachable",
      retryable: true,
    });
    expect(
      await createResendEmailTransport({ apiKey: "k", from: "a@b.test" }).send({
        ...message,
        channel: "sms",
      }),
    ).toMatchObject({ ok: false, code: "resend_channel_unsupported" });
  });

  it("renders a route link only when a console origin is known", () => {
    expect(renderEmailParts(message).text).toBe(message.body);
    expect(renderEmailParts(message, "https://c.test").text).toContain("https://c.test/?open=");
  });

  it("routes email to Resend and SMS to the fallback, and stays recorded in e2e", async () => {
    const sent: string[] = [];
    const stub = (name: string) => ({
      send: async (m: ChannelMessage) => {
        sent.push(`${name}:${m.channel}`);
        return { ok: true as const, ticketId: name };
      },
    });
    const split = splitEmailTransport(stub("email"), stub("other"));
    await split.send(message);
    await split.send({ ...message, channel: "sms" });
    expect(sent).toEqual(["email:email", "other:sms"]);

    const base = {
      OPERLOOM_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "k",
      OPERLOOM_EMAIL_FROM: "a@b.test",
    };
    const e2e = resolveChannelTransport({ ...base, OPERLOOM_E2E_MODE: "true" } as unknown as Env);
    expect(await e2e.send(message)).toMatchObject({
      ok: true,
      ticketId: expect.stringMatching(/^recorded:/),
    });
    expect(() =>
      resolveChannelTransport({ OPERLOOM_EMAIL_PROVIDER: "resend" } as unknown as Env),
    ).toThrow(/email_provider_resend_misconfigured/);
    expect(resolveChannelTransport(base as unknown as Env)).toBeTruthy();
  });
});
