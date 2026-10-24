// Repeated staging probe: console + Worker + DO paths reachable without a WorkOS session.
const WEB = "https://operloom-staging-web.fly.dev";
const API = "https://operloom-staging-control-plane.david-erwin-cz68.workers.dev";
const rounds = Number(process.argv[2] ?? 10);
const checks = [
  { name: "web /api/health", url: `${WEB}/api/health`, expect: 200 },
  { name: "web / (home)", url: `${WEB}/`, expect: 200 },
  {
    name: "web /sign-in -> WorkOS",
    url: `${WEB}/sign-in`,
    expect: 307,
    redirect: "manual",
    must: (r) => (r.headers.get("location") ?? "").includes("api.workos.com"),
  },
  { name: "web signed-out api 401", url: `${WEB}/api/workbench/chat-session`, expect: 401 },
  { name: "web v1 proxy 401", url: `${WEB}/api/v1/me/chat/session`, expect: 401 },
  {
    name: "worker /health",
    url: `${API}/health`,
    expect: 200,
    must: async (r) => (await r.clone().json()).ok === true,
  },
  {
    name: "worker bad token 401",
    url: `${API}/v1/me/chat/session`,
    expect: 401,
    headers: { authorization: "Bearer not-a-token" },
  },
  {
    name: "worker preflight CORS",
    url: `${API}/v1/me`,
    method: "OPTIONS",
    expect: 204,
    headers: { origin: WEB, "access-control-request-method": "GET" },
    must: (r) => r.headers.get("access-control-allow-origin") === WEB,
  },
  { name: "worker openapi", url: `${API}/v1/openapi.json`, expect: 200 },
  {
    name: "worker agents ws handshake 401",
    url: `${API}/agents/thread-chat-agent/thread-does-not-exist`,
    expect: [401, 403, 404, 426],
  },
];
const stats = new Map();
for (let round = 1; round <= rounds; round++) {
  for (const c of checks) {
    const s = stats.get(c.name) ?? { ok: 0, fail: 0, times: [], errors: [] };
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(c.url, {
        method: c.method ?? "GET",
        headers: c.headers,
        redirect: c.redirect ?? "manual",
        signal: ctl.signal,
      });
      clearTimeout(t);
      const okStatus = Array.isArray(c.expect)
        ? c.expect.includes(r.status)
        : r.status === c.expect;
      const okMust = c.must ? await c.must(r) : true;
      await r.arrayBuffer().catch(() => {});
      if (okStatus && okMust) s.ok++;
      else {
        s.fail++;
        s.errors.push(`r${round}: status=${r.status} must=${okMust}`);
      }
    } catch (e) {
      s.fail++;
      s.errors.push(`r${round}: ${e.name}`);
    }
    s.times.push(Date.now() - t0);
    stats.set(c.name, s);
  }
  await new Promise((r) => setTimeout(r, 400));
}
let failed = 0;
for (const [name, s] of stats) {
  const sorted = [...s.times].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)],
    p95 = sorted[Math.floor(sorted.length * 0.95)],
    max = sorted.at(-1);
  console.log(
    `${s.fail ? "FAIL" : "ok  "} ${name.padEnd(32)} ${String(s.ok).padStart(3)}/${rounds}  p50=${p50}ms p95=${p95}ms max=${max}ms${s.errors.length ? "  " + s.errors.slice(0, 3).join("; ") : ""}`,
  );
  if (s.fail) failed++;
}
process.exit(failed ? 1 : 0);
