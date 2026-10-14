import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeArtifact } from "@operloom/agent-sdk";
import { createRunnerRecipes } from "./recipes";

let server: Server;
let origin = "";
const roots: string[] = [];
const page = `<!doctype html><html><head><title>Permit notice</title><script src="https://tracker.example/t.js"></script></head>
<body><h1 id="headline">Permit approved</h1><p>Issued to 12 Elm St.</p></body></html>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://elsewhere.example/" });
      response.end();
      return;
    }
    if (request.url === "/slow") return;
    response.writeHead(request.url === "/missing" ? 404 : 200, { "content-type": "text/html" });
    response.end(page);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const workspace = async () => {
  const root = await mkdtemp(resolve(tmpdir(), "operloom-recipes-"));
  roots.push(root);
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@10", scripts: { build: "x", "lint:fix": "y" } }),
  );
  await mkdir(resolve(root, "docs"));
  await writeFile(resolve(root, "docs/guide.md"), "# Guide\n\nHello world from the guide.");
  await writeFile(resolve(root, ".env"), "SECRET=x");
  await writeFile(resolve(root, "data.csv"), 'name,qty\n"Shingle, grey",12\nNails,400\n');
  return root;
};

const recipes = (root: string, extra: Partial<Parameters<typeof createRunnerRecipes>[0]> = {}) => {
  const artifacts: RuntimeArtifact[] = [];
  return {
    artifacts,
    recipes: createRunnerRecipes({
      root,
      preferFetch: true,
      artifacts,
      networkPolicy: { egress: "public_web", allowedHosts: ["127.0.0.1"], deniedHosts: [] },
      ...extra,
    }),
  };
};

describe("runner recipes", () => {
  it("runs a bounded process with a minimal environment and redacts secrets", async () => {
    const root = await workspace();
    const { recipes: r } = recipes(root);
    const ok = await r.process({
      command: "sh",
      args: ["-c", "echo token=abc123; echo $SECRET_FROM_RUNNER; pwd"],
    });
    expect(ok.status).toBe("completed");
    expect(ok.stdout).toContain("token=[redacted]");
    expect(ok.stdout).not.toContain("abc123");
    expect(ok.stdout.trim().endsWith(root) || ok.stdout.includes(root)).toBe(true);
    const capped = await r.process({
      command: "sh",
      args: ["-c", "yes | head -c 5000"],
      maxOutputBytes: 1024,
    });
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.stdout)).toBeLessThan(1200);
    const timeout = await r.process({ command: "sleep", args: ["5"], timeoutMs: 200 });
    expect(timeout.status).toBe("timeout");
    expect(await r.process({ command: "definitely-not-a-binary-xyz" })).toMatchObject({
      status: "unavailable",
    });
    expect(await r.process({ command: "sh", cwd: "../../" })).toMatchObject({
      status: "failed",
      stderr: "cwd_outside_root",
    });
    expect(await r.process({ command: "sh;rm" })).toMatchObject({
      status: "failed",
      stderr: "command_invalid",
    });
    expect(r.usage().map((item) => item.recipe)).toEqual([
      "process",
      "process",
      "process",
      "process",
      "process",
      "process",
    ]);
  });

  it("reads documents inside the root only and parses json and csv", async () => {
    const root = await workspace();
    const { recipes: r } = recipes(root);
    const md = await r.document({ source: { path: "docs/guide.md" }, kind: "markdown" });
    expect(md).toMatchObject({ status: "completed", wordCount: 7, truncated: false });
    const csv = await r.document({ source: { path: "data.csv" }, kind: "csv" });
    expect(csv.data).toEqual([
      { name: "Shingle, grey", qty: "12" },
      { name: "Nails", qty: "400" },
    ]);
    const json = await r.document({ source: { text: '{"a":1}' }, kind: "json" });
    expect(json.data).toEqual({ a: 1 });
    expect(await r.document({ source: { path: "../etc/passwd" }, kind: "text" })).toMatchObject({
      status: "failed",
    });
    expect(await r.document({ source: { path: "/etc/passwd" }, kind: "text" })).toMatchObject({
      status: "failed",
    });
    expect(await r.document({ source: { path: "nope.txt" }, kind: "text" })).toMatchObject({
      status: "unavailable",
    });
    const big = await r.document({
      source: { text: "x".repeat(5000) },
      kind: "text",
      maxBytes: 1024,
    });
    expect(big.truncated).toBe(true);
  });

  it("lists a local repository with ripgrep, excluding secrets and node_modules", async () => {
    const root = await workspace();
    const { recipes: r } = recipes(root);
    const listing = await r.repository({ source: "." });
    if (listing.status === "unavailable") return; // ripgrep not installed on this host
    expect(listing.status).toBe("completed");
    expect(listing.files).toEqual(
      expect.arrayContaining(["package.json", "docs/guide.md", "data.csv"]),
    );
    expect(listing.files.some((file) => file.startsWith(".env"))).toBe(false);
    expect(listing).toMatchObject({ packageManager: "pnpm@10", scripts: ["build", "lint:fix"] });
    const docs = await r.repository({ source: "docs", maxFiles: 1 });
    expect(docs.files).toEqual(["guide.md"]);
    expect(await r.repository({ source: "../" })).toMatchObject({ status: "failed" });
    expect(await r.repository({ source: "https://github.example/x.git" })).toMatchObject({
      status: "failed",
    });
  });

  it("scrapes a page through the fetch engine, honouring host allowlists and byte caps", async () => {
    const root = await workspace();
    const { recipes: r, artifacts } = recipes(root);
    const read = await r.browser({
      url: `${origin}/page`,
      allowHosts: ["127.0.0.1"],
      extract: { headline: "#headline" },
    });
    expect(read).toMatchObject({
      status: "completed",
      engine: "fetch",
      title: "Permit notice",
      fields: { headline: "Permit approved" },
    });
    expect(read.text).toContain("Issued to 12 Elm St.");
    expect(read.text).not.toContain("tracker.example");
    expect(await r.browser({ url: `${origin}/page`, allowHosts: ["other.example"] })).toMatchObject(
      { status: "blocked" },
    );
    expect(await r.browser({ url: `${origin}/redirect`, allowHosts: ["127.0.0.1"] })).toMatchObject(
      { status: "blocked", blockedRequests: 1 },
    );
    expect(await r.browser({ url: `${origin}/missing`, allowHosts: ["127.0.0.1"] })).toMatchObject({
      status: "failed",
    });
    expect(
      await r.browser({ url: `${origin}/slow`, allowHosts: ["127.0.0.1"], timeoutMs: 300 }),
    ).toMatchObject({ status: "timeout" });
    expect(await r.browser({ url: "ftp://127.0.0.1/x", allowHosts: ["127.0.0.1"] })).toMatchObject({
      status: "blocked",
    });
    const denied = recipes(root, {
      networkPolicy: { egress: "none", allowedHosts: [], deniedHosts: [] },
    });
    expect(
      await denied.recipes.browser({ url: `${origin}/page`, allowHosts: ["127.0.0.1"] }),
    ).toMatchObject({ status: "blocked" });
    const capped = await r.browser({
      url: `${origin}/page`,
      allowHosts: ["127.0.0.1"],
      maxBytes: 1024,
    });
    expect(capped.status).toBe("completed");
    await r.artifact.upload({
      kind: "page_excerpt",
      title: "x",
      mimeType: "application/json",
      data: { text: capped.text },
    });
    expect(artifacts).toHaveLength(1);
    expect(r.usage().filter((item) => item.recipe === "artifact")).toHaveLength(1);
  });

  it("stops at the total byte budget", async () => {
    const root = await workspace();
    const { recipes: r } = recipes(root, { maxTotalBytes: 2048 });
    await r.document({ source: { text: "x".repeat(1500) }, kind: "text" });
    await expect(
      r.document({ source: { text: "y".repeat(1500) }, kind: "text" }),
    ).rejects.toMatchObject({
      code: "recipe_budget_exceeded",
    });
  });
});
