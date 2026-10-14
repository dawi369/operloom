import type { RuntimeRecord } from "./runtime.js";

/**
 * Bounded building blocks the signed runner offers to `runner.ts` tools through
 * `context.recipes`. Every recipe enforces a timeout and a byte cap, reports
 * what it used, and returns a typed, bounded result. Tools compose these
 * instead of reaching for `child_process`, `fs` or a browser directly.
 */

export type RecipeUsage = {
  recipe: "process" | "browser" | "repository" | "document" | "artifact";
  durationMs: number;
  bytes: number;
};

export type ProcessRecipeInput = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Default 10 000, max 120 000. */
  timeoutMs?: number;
  /** Default 65 536, max 1 048 576. */
  maxOutputBytes?: number;
  env?: Readonly<Record<string, string>>;
};

export type ProcessRecipeResult = {
  status: "completed" | "failed" | "timeout" | "unavailable";
  exitCode?: number;
  /** Secrets-looking tokens are redacted; output past the cap is truncated. */
  stdout: string;
  stderr: string;
  truncated: boolean;
  usage: RecipeUsage;
};

export type BrowserRecipeInput = {
  url: string;
  /** Hosts the page and its requests may touch; everything else is blocked. */
  allowHosts: readonly string[];
  /** Default 15 000, max 60 000. */
  timeoutMs?: number;
  /** Default 262 144, max 2 097 152; applies to the extracted text. */
  maxBytes?: number;
  /** Wait for this selector before extracting. */
  waitForSelector?: string;
  /** CSS selectors whose text is returned under `fields`. */
  extract?: Readonly<Record<string, string>>;
};

export type BrowserRecipeResult = {
  status: "completed" | "blocked" | "timeout" | "unavailable" | "failed";
  finalUrl?: string;
  title?: string;
  /** Visible text of the page, bounded. */
  text: string;
  fields: Readonly<Record<string, string>>;
  blockedRequests: number;
  /** `headless` when a real browser rendered the page, `fetch` for the HTML fallback. */
  engine: "headless" | "fetch";
  usage: RecipeUsage;
};

export type RepositoryRecipeInput = {
  /** A local checkout path or a `https://` clone URL. */
  source: string;
  /** Clone depth when `source` is a URL. Default 1. */
  depth?: number;
  /** ripgrep globs; `node_modules`, `.git` and `.env*` are always excluded. */
  include?: readonly string[];
  /** Default 200, max 2 000. */
  maxFiles?: number;
  timeoutMs?: number;
};

export type RepositoryRecipeResult = {
  status: "completed" | "failed" | "timeout" | "unavailable";
  root: string;
  files: readonly string[];
  truncated: boolean;
  packageManager?: string;
  scripts: readonly string[];
  usage: RecipeUsage;
};

export type DocumentRecipeInput = {
  /** A local file path (under the recipe's working root) or inline `text`. */
  source: { path: string } | { text: string };
  kind: "text" | "markdown" | "json" | "csv";
  /** Default 262 144, max 4 194 304. */
  maxBytes?: number;
};

export type DocumentRecipeResult = {
  status: "completed" | "failed" | "unavailable";
  kind: DocumentRecipeInput["kind"];
  text: string;
  truncated: boolean;
  /** Parsed form for `json` and `csv`; absent for text kinds. */
  data?: RuntimeRecord | readonly RuntimeRecord[];
  wordCount: number;
  usage: RecipeUsage;
};

export type ArtifactUploadInput = {
  kind: string;
  title: string;
  mimeType: string;
  data: RuntimeRecord;
};

export type RunnerRecipes = {
  process(input: ProcessRecipeInput): Promise<ProcessRecipeResult>;
  browser(input: BrowserRecipeInput): Promise<BrowserRecipeResult>;
  repository(input: RepositoryRecipeInput): Promise<RepositoryRecipeResult>;
  document(input: DocumentRecipeInput): Promise<DocumentRecipeResult>;
  artifact: {
    /** Stages an artifact the tool result will publish; returns the ref callers may cite. */
    upload(input: ArtifactUploadInput): Promise<{ kind: string; title: string; sizeBytes: number }>;
  };
  /** Everything consumed so far in this tool call. */
  usage(): readonly RecipeUsage[];
};

export const recipeLimits = {
  process: {
    timeoutMs: { default: 10_000, max: 120_000 },
    maxOutputBytes: { default: 65_536, max: 1_048_576 },
  },
  browser: {
    timeoutMs: { default: 15_000, max: 60_000 },
    maxBytes: { default: 262_144, max: 2_097_152 },
  },
  repository: {
    timeoutMs: { default: 30_000, max: 120_000 },
    maxFiles: { default: 200, max: 2_000 },
  },
  document: { maxBytes: { default: 262_144, max: 4_194_304 } },
} as const;

export const clampLimit = (value: number | undefined, bound: { default: number; max: number }) =>
  Math.min(bound.max, Math.max(1, Math.trunc(value ?? bound.default)));
