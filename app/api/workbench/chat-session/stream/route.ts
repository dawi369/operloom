import { NextResponse } from "next/server";

import { toWorkbenchApiError } from "@/lib/workbench/api-errors";
import { createBoundedSseStream } from "@/lib/workbench/bounded-sse";
import { streamChatSessionEvents } from "@/lib/workbench/cloudflare-control-plane-client";

export const runtime = "nodejs";
const vercelSseReconnectWindowMs = 240_000;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const response = await streamChatSessionEvents({
      after: url.searchParams.get("after") ?? undefined,
      lastEventId: request.headers.get("Last-Event-ID") ?? undefined,
    });
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.set("cache-control", "no-store");
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.set("x-operloom-sse-policy", "bounded-reconnect");
    headers.set("x-operloom-sse-reconnect-ms", String(vercelSseReconnectWindowMs));

    return new NextResponse(
      createBoundedSseStream({
        body: response.body,
        maxDurationMs: vercelSseReconnectWindowMs,
        reconnectComment: "workbench bounded reconnect",
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  } catch (error) {
    return toWorkbenchApiError(error, "Cloudflare chat session stream failed");
  }
}
