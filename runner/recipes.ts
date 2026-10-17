import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import {
  clampLimit,
  recipeLimits,
  type ArtifactUploadInput,
  type BrowserRecipeInput,
  type BrowserRecipeResult,
  type DocumentRecipeInput,
  type DocumentRecipeResult,
  type ProcessRecipeInput,
  type ProcessRecipeResult,
  type RecipeUsage,
  type RepositoryRecipeInput,
  type RepositoryRecipeResult,
  type RunnerRecipes,
} from "@operloom/agent-sdk/runner";
import type { RuntimeArtifact, RuntimeRecord } from "@operloom/agent-sdk";

const redact = (value: string) =>
  value
    .replace(/(api[_-]?key|token|secret|password)=?[^\s"']*/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");

const byteCap = (value: string, maxBytes: number) => {
  const buffer = Buffer.from(value, "utf8");
  return buffer.length <= maxBytes
    ? { text: value, truncated: false }
    : { text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated]`, truncated: true };
};

const commandAllowed = (command: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(command);
const argAllowed = (arg: string) => arg.length <= 4096 && !/[\0\r\n]/.test(arg);

const hostAllowed = (allow: readonly string[], hostname: string) =>
  allow.some((entry) => {
    const host = entry.toLowerCase();
    const target = hostname.toLowerCase();
    return host.startsWith("*.") ? target.endsWith(host.slice(1)) : target === host;
  });

type RecipeOptions = {
  /** Working root for processes and document paths; tools cannot escape it. */
  root: string;
  networkPolicy?: {
    egress: "none" | "public_web" | "broker_only";
    allowedHosts: readonly string[];
    deniedHosts: readonly string[];
  };
  /** Local E2E mode skips the headless browser and uses the fetch engine. */
  preferFetch?: boolean;
  artifacts: RuntimeArtifact[];
  /** Total byte budget across recipes in this tool call. Default 8 MiB. */
  maxTotalBytes?: number;
};

const insideRoot = (root: string, candidate: string) => {
  const resolved = resolve(root, candidate);
  return resolved === root || resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
    ? resolved
    : null;
};

export const runProcess = (
  input: ProcessRecipeInput,
  root: string,
): Promise<Omit<ProcessRecipeResult, "usage"> & { durationMs: number; bytes: number }> =>
  new Promise((done) => {
    const startedAt = Date.now();
    const timeoutMs = clampLimit(input.timeoutMs, recipeLimits.process.timeoutMs);
    const maxOutputBytes = clampLimit(input.maxOutputBytes, recipeLimits.process.maxOutputBytes);
    const args = input.args ?? [];
    if (!commandAllowed(input.command) || !args.every(argAllowed)) {
      done({
        status: "failed",
        stdout: "",
        stderr: "command_invalid",
        truncated: false,
        durationMs: 0,
        bytes: 0,
      });
      return;
    }
    const cwd = input.cwd ? insideRoot(root, input.cwd) : root;
    if (!cwd) {
      done({
        status: "failed",
        stdout: "",
        stderr: "cwd_outside_root",
        truncated: false,
        durationMs: 0,
        bytes: 0,
      });
      return;
    }
    // Minimal environment: PATH plus explicit tool-provided variables, never the runner's secrets.
    const child = spawn(input.command, [...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpdir(),
        ...input.env,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (current: string, chunk: Buffer, cap: number) => {
      const next = byteCap(current + chunk.toString("utf8"), cap);
      truncated ||= next.truncated;
      return next.text;
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = collect(stdout, chunk, maxOutputBytes)));
    child.stderr.on(
      "data",
      (chunk: Buffer) => (stderr = collect(stderr, chunk, Math.min(maxOutputBytes, 16_384))),
    );
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      done({
        status: "unavailable",
        stdout: "",
        stderr: redact(error.message),
        truncated: false,
        durationMs: Date.now() - startedAt,
        bytes: Buffer.byteLength(error.message),
      });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const out = redact(stdout);
      const err = redact(stderr);
      done({
        status: timedOut ? "timeout" : code === 0 ? "completed" : "failed",
        exitCode: code ?? undefined,
        stdout: out,
        stderr: err,
        truncated,
        durationMs: Date.now() - startedAt,
        bytes: Buffer.byteLength(out) + Buffer.byteLength(err),
      });
    });
  });

const visibleText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const titleOf = (html: string) => /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();

/** HTML fetch engine: no JavaScript, one request, the same host and byte bounds. */
const fetchEngine = async (
  input: BrowserRecipeInput,
  timeoutMs: number,
  maxBytes: number,
): Promise<Omit<BrowserRecipeResult, "usage">> => {
  const url = new URL(input.url);
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    const next = location ? new URL(location, url) : null;
    if (!next || !hostAllowed(input.allowHosts, next.hostname))
      return { status: "blocked", text: "", fields: {}, blockedRequests: 1, engine: "fetch" };
    return fetchEngine({ ...input, url: next.toString() }, timeoutMs, maxBytes);
  }
  if (!response.ok)
    return {
      status: "failed",
      finalUrl: url.toString(),
      text: "",
      fields: {},
      blockedRequests: 0,
      engine: "fetch",
    };
  const html = (await response.text()).slice(0, maxBytes * 4);
  const text = byteCap(visibleText(html), maxBytes);
  const fields: Record<string, string> = {};
  for (const [name, selector] of Object.entries(input.extract ?? {})) {
    // Fetch engine supports id and simple tag selectors only; others resolve to the whole text.
    const id = /^#([A-Za-z][\w-]*)$/.exec(selector)?.[1];
    const match = id
      ? new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/`, "i").exec(html)?.[1]
      : /^[a-z][a-z0-9]*$/i.test(selector)
        ? new RegExp(`<${selector}[^>]*>([\\s\\S]*?)<\\/${selector}>`, "i").exec(html)?.[1]
        : undefined;
    fields[name] = byteCap(visibleText(match ?? ""), 4096).text;
  }
  return {
    status: "completed",
    finalUrl: url.toString(),
    title: titleOf(html),
    text: text.text,
    fields,
    blockedRequests: 0,
    engine: "fetch",
  };
};

type HeadlessPage = {
  route(
    pattern: string,
    handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  goto(
    url: string,
    options: { timeout: number; waitUntil: "domcontentloaded" },
  ): Promise<{ status(): number } | null>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  locator(selector: string): {
    first(): { innerText(): Promise<string> };
    innerText(): Promise<string>;
  };
  url(): string;
  title(): Promise<string>;
};
type HeadlessBrowser = {
  newPage(options: { javaScriptEnabled: boolean }): Promise<HeadlessPage>;
  close(): Promise<void>;
};

const headlessEngine = async (
  input: BrowserRecipeInput,
  timeoutMs: number,
  maxBytes: number,
): Promise<Omit<BrowserRecipeResult, "usage"> | null> => {
  // The test package re-exports the browser API; it is a dev dependency, so production
  // images without it fall back to the fetch engine.
  type Chromium = { launch(options: { headless: boolean }): Promise<HeadlessBrowser> };
  let chromium: Chromium | null = null;
  try {
    const mod = (await import("@playwright/test")) as unknown as { chromium?: Chromium };
    chromium = mod.chromium ?? null;
  } catch {
    return null;
  }
  if (!chromium) return null;
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return null;
  let blockedRequests = 0;
  try {
    const page = await browser.newPage({ javaScriptEnabled: true });
    await page.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      if (hostAllowed(input.allowHosts, host)) return route.continue();
      blockedRequests += 1;
      return route.abort();
    });
    const response = await page.goto(input.url, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    if (input.waitForSelector)
      await page.waitForSelector(input.waitForSelector, { timeout: timeoutMs });
    const fields: Record<string, string> = {};
    for (const [name, selector] of Object.entries(input.extract ?? {}))
      fields[name] = byteCap(
        (
          await page
            .locator(selector)
            .first()
            .innerText()
            .catch(() => "")
        ).trim(),
        4096,
      ).text;
    const text = byteCap(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
      maxBytes,
    );
    return {
      status: response && response.status() >= 400 ? "failed" : "completed",
      finalUrl: page.url(),
      title: await page.title(),
      text: text.text,
      fields,
      blockedRequests,
      engine: "headless",
    };
  } catch (error) {
    return {
      status: error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "failed",
      text: "",
      fields: {},
      blockedRequests,
      engine: "headless",
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const browse = async (input: BrowserRecipeInput, options: RecipeOptions) => {
  const startedAt = Date.now();
  const timeoutMs = clampLimit(input.timeoutMs, recipeLimits.browser.timeoutMs);
  const maxBytes = clampLimit(input.maxBytes, recipeLimits.browser.maxBytes);
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return {
      status: "failed" as const,
      text: "",
      fields: {},
      blockedRequests: 0,
      engine: "fetch" as const,
      durationMs: 0,
    };
  }
  const policy = options.networkPolicy;
  const blocked =
    !["http:", "https:"].includes(target.protocol) ||
    !hostAllowed(input.allowHosts, target.hostname) ||
    policy?.egress === "none" ||
    (policy?.deniedHosts ?? []).some((host) => hostAllowed([host], target.hostname)) ||
    (policy?.egress === "public_web" &&
      policy.allowedHosts.length > 0 &&
      !hostAllowed(policy.allowedHosts, target.hostname));
  if (blocked)
    return {
      status: "blocked" as const,
      text: "",
      fields: {},
      blockedRequests: 1,
      engine: "fetch" as const,
      durationMs: 0,
    };
  const result =
    (options.preferFetch ? null : await headlessEngine(input, timeoutMs, maxBytes)) ??
    (await fetchEngine(input, timeoutMs, maxBytes).catch(
      (error): Omit<BrowserRecipeResult, "usage"> => ({
        status: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "failed",
        text: "",
        fields: {},
        blockedRequests: 0,
        engine: "fetch",
      }),
    ));
  return { ...result, durationMs: Date.now() - startedAt };
};

const readPackage = async (root: string) => {
  try {
    const parsed = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      packageManager?: string;
      scripts?: Record<string, unknown>;
    };
    return {
      packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
      scripts: parsed.scripts
        ? Object.keys(parsed.scripts)
            .filter((name) => /^[a-z0-9:_-]{1,64}$/i.test(name))
            .sort()
            .slice(0, 40)
        : [],
    };
  } catch {
    return { packageManager: undefined, scripts: [] as string[] };
  }
};

const repository = async (
  input: RepositoryRecipeInput,
  options: RecipeOptions,
): Promise<Omit<RepositoryRecipeResult, "usage"> & { durationMs: number; bytes: number }> => {
  const startedAt = Date.now();
  const timeoutMs = clampLimit(input.timeoutMs, recipeLimits.repository.timeoutMs);
  const maxFiles = clampLimit(input.maxFiles, recipeLimits.repository.maxFiles);
  let root = options.root;
  let scratch: string | null = null;
  const fail = (status: RepositoryRecipeResult["status"], bytes = 0) => ({
    status,
    root: "",
    files: [] as string[],
    truncated: false,
    scripts: [] as string[],
    durationMs: Date.now() - startedAt,
    bytes,
  });
  try {
    if (input.source.startsWith("https://")) {
      const url = new URL(input.source);
      const policy = options.networkPolicy;
      if (
        policy?.egress === "none" ||
        (policy?.deniedHosts ?? []).some((host) => hostAllowed([host], url.hostname)) ||
        (policy?.egress === "public_web" &&
          policy.allowedHosts.length > 0 &&
          !hostAllowed(policy.allowedHosts, url.hostname))
      )
        return fail("failed");
      scratch = await mkdtemp(resolve(tmpdir(), "operloom-repo-"));
      const clone = await runProcess(
        {
          command: "git",
          args: [
            "clone",
            "--depth",
            String(Math.max(1, Math.trunc(input.depth ?? 1))),
            "--quiet",
            url.toString(),
            "checkout",
          ],
          timeoutMs,
        },
        scratch,
      );
      if (clone.status !== "completed")
        return fail(clone.status === "unavailable" ? "unavailable" : clone.status, clone.bytes);
      root = resolve(scratch, "checkout");
    } else {
      const local = insideRoot(options.root, input.source);
      if (
        !local ||
        !(await stat(local)
          .then((s) => s.isDirectory())
          .catch(() => false))
      )
        return fail("failed");
      root = local;
    }
    const globs = [
      "!node_modules",
      "!.git",
      "!.env*",
      "!.next",
      "!*.tsbuildinfo",
      ...(input.include ?? []),
    ];
    const listed = await runProcess(
      {
        command: "rg",
        args: ["--files", ...globs.flatMap((glob) => ["-g", glob])],
        timeoutMs,
        maxOutputBytes: 1_048_576,
      },
      root,
    );
    if (listed.status === "unavailable") return fail("unavailable", listed.bytes);
    if (listed.status === "timeout") return fail("timeout", listed.bytes);
    const all = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(".env") && line !== "[truncated]");
    const files = all.slice(0, maxFiles);
    const pkg = await readPackage(root);
    return {
      status: "completed",
      root: scratch ? "checkout" : input.source,
      files,
      truncated: listed.truncated || all.length > maxFiles,
      packageManager: pkg.packageManager,
      scripts: pkg.scripts,
      durationMs: Date.now() - startedAt,
      bytes: listed.bytes,
    };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
};

const parseCsv = (text: string): RuntimeRecord[] => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const cells = (line: string) => {
    const out: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          current += '"';
          i++;
        } else quoted = !quoted;
      } else if (char === "," && !quoted) {
        out.push(current);
        current = "";
      } else current += char;
    }
    out.push(current);
    return out;
  };
  const header = cells(lines[0]!);
  return lines
    .slice(1, 5001)
    .map((line) =>
      Object.fromEntries(cells(line).map((value, i) => [header[i] ?? `col${i}`, value])),
    );
};

const document = async (
  input: DocumentRecipeInput,
  options: RecipeOptions,
): Promise<Omit<DocumentRecipeResult, "usage"> & { durationMs: number; bytes: number }> => {
  const startedAt = Date.now();
  const maxBytes = clampLimit(input.maxBytes, recipeLimits.document.maxBytes);
  let raw: string;
  if ("text" in input.source) raw = input.source.text;
  else {
    const path = insideRoot(options.root, input.source.path);
    if (!path || isAbsolute(input.source.path))
      return {
        status: "failed",
        kind: input.kind,
        text: "",
        truncated: false,
        wordCount: 0,
        durationMs: 0,
        bytes: 0,
      };
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return {
        status: "unavailable",
        kind: input.kind,
        text: "",
        truncated: false,
        wordCount: 0,
        durationMs: 0,
        bytes: 0,
      };
    }
  }
  const capped = byteCap(raw, maxBytes);
  const text = capped.text;
  let data: DocumentRecipeResult["data"];
  if (input.kind === "json") {
    try {
      const parsed = JSON.parse(capped.truncated ? "" : text) as unknown;
      data =
        parsed && typeof parsed === "object"
          ? (parsed as RuntimeRecord | RuntimeRecord[])
          : undefined;
    } catch {
      data = undefined;
    }
  } else if (input.kind === "csv") data = parseCsv(text);
  return {
    status: "completed",
    kind: input.kind,
    text,
    truncated: capped.truncated,
    ...(data !== undefined ? { data } : {}),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    durationMs: Date.now() - startedAt,
    bytes: Buffer.byteLength(text),
  };
};

/** Recipes for one tool call; usage accumulates and a total byte budget stops runaway reads. */
export const createRunnerRecipes = (options: RecipeOptions): RunnerRecipes => {
  const usage: RecipeUsage[] = [];
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
  const consumed = () => usage.reduce((total, item) => total + item.bytes, 0);
  const charge = (recipe: RecipeUsage["recipe"], durationMs: number, bytes: number) => {
    const entry = { recipe, durationMs, bytes };
    usage.push(entry);
    if (consumed() > maxTotalBytes)
      throw Object.assign(new Error("Recipe byte budget exceeded."), {
        code: "recipe_budget_exceeded",
      });
    return entry;
  };
  return {
    async process(input) {
      const result = await runProcess(input, options.root);
      return { ...result, usage: charge("process", result.durationMs, result.bytes) };
    },
    async browser(input) {
      const result = await browse(input, options);
      return {
        ...result,
        usage: charge("browser", result.durationMs, Buffer.byteLength(result.text)),
      };
    },
    async repository(input) {
      const result = await repository(input, options);
      return { ...result, usage: charge("repository", result.durationMs, result.bytes) };
    },
    async document(input) {
      const result = await document(input, options);
      return { ...result, usage: charge("document", result.durationMs, result.bytes) };
    },
    artifact: {
      async upload(input: ArtifactUploadInput) {
        const sizeBytes = Buffer.byteLength(JSON.stringify(input.data));
        charge("artifact", 0, sizeBytes);
        options.artifacts.push({
          kind: input.kind,
          title: input.title,
          mimeType: input.mimeType,
          data: input.data,
        });
        return { kind: input.kind, title: input.title, sizeBytes };
      },
    },
    usage: () => [...usage],
  };
};
