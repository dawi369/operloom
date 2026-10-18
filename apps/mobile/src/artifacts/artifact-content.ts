import type { ArtifactSummary } from "@operloom/client";

const sensitiveKey = /(authorization|cookie|credential|password|secret|token)/i;
export const defaultRendererMaxBytes = 65_536;

/** Same shape the console applies before handing data to a renderer: no credential-like keys, bounded depth and width. */
export const sanitizeArtifactData = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return "[depth-limited]";
  if (typeof value === "string") return value.slice(0, 16_384);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeArtifactData(item, depth + 1));
  }
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKey.test(key))
      .slice(0, 200)
      .map(([key, item]) => [key, sanitizeArtifactData(item, depth + 1)]),
  );
};

export const withinRendererBound = (value: unknown, maxBytes = defaultRendererMaxBytes) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength <= maxBytes;
  } catch {
    return false;
  }
};

export type ArtifactRow = { path: string; value: string; nested: boolean };

const scalarText = (value: unknown) => {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

/** Flattens artifact data into dotted-path rows for the generic view; a row is `nested` when it only labels a container. */
export const artifactRows = (data: unknown, limit = 400): ArtifactRow[] => {
  const rows: ArtifactRow[] = [];
  const visit = (value: unknown, path: string) => {
    if (rows.length >= limit) return;
    if (Array.isArray(value)) {
      if (!value.length) {
        rows.push({ path, value: "[]", nested: false });
        return;
      }
      if (path) rows.push({ path, value: `${value.length} items`, nested: true });
      value.forEach((item, index) => visit(item, path ? `${path}[${index}]` : `[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (!entries.length) {
        rows.push({ path, value: "{}", nested: false });
        return;
      }
      if (path) rows.push({ path, value: "", nested: true });
      for (const [key, item] of entries) visit(item, path ? `${path}.${key}` : key);
      return;
    }
    rows.push({ path, value: scalarText(value), nested: false });
  };
  visit(data, "");
  return rows.slice(0, limit);
};

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const artifactMeta = (artifact: ArtifactSummary) =>
  [
    artifact.kind,
    artifact.createdAt ? artifact.createdAt.slice(0, 10) : null,
    typeof artifact.sizeBytes === "number" ? formatBytes(artifact.sizeBytes) : null,
    artifact.mimeType && artifact.mimeType !== "application/json" ? artifact.mimeType : null,
  ]
    .filter(Boolean)
    .join(" · ");
