import { test as base } from "@playwright/test";

export * from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use) => {
    // Journeys use the development server for local-only identity, but do not
    // edit source. Next's compiler refresh messages can arrive before router
    // initialization and interrupt hydration. Silence only that development
    // refresh event while retaining the compiler handshake; application
    // sockets, requests, and authentication remain real.
    await context.routeWebSocket(
      (url) => url.pathname === "/_next/webpack-hmr",
      (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => {
          if (typeof message === "string") {
            const payload = JSON.parse(message) as { type?: string };
            if (payload.type === "serverComponentChanges") return;
          }
          socket.send(message);
        });
      },
    );
    await use(context);
  },
});
