import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  urlInspectError,
  type UrlInspectOutput,
  type UrlInspectResult,
} from "../lib/workbench/url-inspect";

const timeoutMs = 5_000;
const maxBytes = 128 * 1024;
const maxRedirects = 3;

type PublicUrlInspectPolicy = {
  egress?: "none" | "public_web" | "broker_only";
  allowedSchemes?: readonly string[];
  allowedHosts?: readonly string[];
  deniedHosts?: readonly string[];
};

const matchesHost = (hostname: string, pattern: string) => {
  const host = hostname.toLowerCase();
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "*") return true;
  if (normalized === host) return true;
  if (normalized.startsWith("*.")) return host.endsWith(normalized.slice(1));
  if (normalized.startsWith(".")) return host.endsWith(normalized);
  return false;
};

const ipv4Bytes = (value: string) => {
  const bytes = value.split(".").map(Number);
  return bytes.length === 4 &&
    bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)
    ? bytes
    : null;
};

const ipv6Bytes = (value: string) => {
  const withoutZone = value.split("%")[0].toLowerCase();
  const mappedIndex = withoutZone.lastIndexOf(":");
  const mappedIpv4 = mappedIndex >= 0 ? ipv4Bytes(withoutZone.slice(mappedIndex + 1)) : null;
  const source = mappedIpv4
    ? `${withoutZone.slice(0, mappedIndex)}:${((mappedIpv4[0] << 8) | mappedIpv4[1]).toString(16)}:${((mappedIpv4[2] << 8) | mappedIpv4[3]).toString(16)}`
    : withoutZone;
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const parsed = Number.parseInt(group, 16);
    bytes.push(parsed >> 8, parsed & 0xff);
  }
  return bytes;
};

export const isPublicInternetAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    if (!bytes) return false;
    const [a, b, c] = bytes;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;
    const mapped =
      bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mapped) return isPublicInternetAddress(bytes.slice(12).join("."));
    const documentation =
      bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
    return bytes[0] >= 0x20 && bytes[0] <= 0x3f && !documentation;
  }
  return false;
};

export const validatePublicUrlPort = (url: URL) =>
  !url.port ||
  (url.protocol === "http:" && url.port === "80") ||
  (url.protocol === "https:" && url.port === "443");

type PinnedRequestOptions = RequestOptions & { servername?: string };

export const pinnedRequestOptions = (
  url: URL,
  address: string,
  family: 4 | 6,
): PinnedRequestOptions => ({
  protocol: url.protocol,
  hostname: address,
  family,
  port: url.port || (url.protocol === "https:" ? 443 : 80),
  path: `${url.pathname}${url.search}`,
  method: "GET",
  servername: url.protocol === "https:" ? url.hostname : undefined,
  headers: {
    host: url.host,
    accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.8,*/*;q=0.5",
    "user-agent": "operloom-url-inspect/1",
  },
});

const resolvePublicAddress = async (hostname: string) => {
  if (isIP(hostname)) {
    if (!isPublicInternetAddress(hostname)) throw new Error("blocked_address");
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicInternetAddress(entry.address))) {
    throw new Error("blocked_address");
  }
  return addresses[0] as { address: string; family: 4 | 6 };
};

const readResponse = (url: URL, address: string, family: 4 | 6, signal: AbortSignal) =>
  new Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    truncated: boolean;
  }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      pinnedRequestOptions(url, address, family),
      (response) => {
        const chunks: Buffer[] = [];
        let downloaded = 0;
        let truncated = false;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers: response.headers,
            body: Buffer.concat(chunks),
            truncated,
          });
        };
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = maxBytes - downloaded;
          if (remaining <= 0) {
            truncated = true;
            response.destroy();
            return;
          }
          const accepted = buffer.subarray(0, remaining);
          chunks.push(accepted);
          downloaded += accepted.length;
          if (accepted.length < buffer.length) {
            truncated = true;
            response.destroy();
          }
        });
        response.once("end", finish);
        response.once("close", finish);
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    signal.addEventListener("abort", () => request.destroy(new Error("timeout")), { once: true });
    request.end();
  });

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const titleFrom = (text: string) =>
  text
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || null;

export const inspectPublicUrl = async (
  initialUrl: URL,
  policy: PublicUrlInspectPolicy = {},
): Promise<UrlInspectResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let url = initialUrl;
  const visited = new Set<string>();

  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      if (
        (policy.egress !== undefined && policy.egress !== "public_web") ||
        (policy.allowedSchemes && !policy.allowedSchemes.includes(url.protocol.slice(0, -1)))
      ) {
        return {
          ok: false,
          error: urlInspectError(
            "sandbox_egress_not_allowed",
            "The signed runner policy blocks this request.",
          ),
        };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {
          ok: false,
          error: urlInspectError("url_protocol_blocked", "Only HTTP and HTTPS URLs are supported."),
        };
      }
      if (url.username || url.password) {
        return {
          ok: false,
          error: urlInspectError("url_credentials_blocked", "URL credentials are not supported."),
        };
      }
      if (!validatePublicUrlPort(url)) {
        return {
          ok: false,
          error: urlInspectError(
            "url_port_blocked",
            "Only standard HTTP and HTTPS ports are supported.",
          ),
        };
      }
      if (policy.deniedHosts?.some((pattern) => matchesHost(url.hostname, pattern))) {
        return {
          ok: false,
          error: urlInspectError(
            policy.egress ? "sandbox_egress_not_allowed" : "url_host_blocked",
            "The URL host is blocked by tool policy.",
          ),
        };
      }
      if (
        policy.allowedHosts?.length &&
        !policy.allowedHosts.some((pattern) => matchesHost(url.hostname, pattern))
      ) {
        return {
          ok: false,
          error: urlInspectError(
            policy.egress ? "sandbox_egress_not_allowed" : "url_host_blocked",
            "The URL host is not allowed by tool policy.",
          ),
        };
      }
      if (visited.has(url.toString())) {
        return {
          ok: false,
          error: urlInspectError("url_redirect_loop", "URL redirect loop detected."),
        };
      }
      visited.add(url.toString());
      const resolved = await resolvePublicAddress(url.hostname);
      const response = await readResponse(
        url,
        resolved.address,
        resolved.family,
        controller.signal,
      );
      if (response.status >= 300 && response.status < 400) {
        const location = firstHeader(response.headers.location);
        if (!location) {
          return {
            ok: false,
            error: urlInspectError(
              "url_redirect_invalid",
              "Redirect response did not include a location.",
            ),
          };
        }
        if (redirects === maxRedirects) {
          return {
            ok: false,
            error: urlInspectError("url_redirect_limit", "URL exceeded the redirect limit."),
          };
        }
        const next = new URL(location, url);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return {
            ok: false,
            error: urlInspectError(
              "url_redirect_blocked",
              "Redirect target must use HTTP or HTTPS.",
            ),
          };
        }
        url = next;
        continue;
      }

      const contentType = firstHeader(response.headers["content-type"]) ?? null;
      const contentLengthRaw = firstHeader(response.headers["content-length"]);
      const contentLength =
        contentLengthRaw && Number.isFinite(Number(contentLengthRaw))
          ? Number(contentLengthRaw)
          : null;
      const title = contentType?.toLowerCase().includes("html")
        ? titleFrom(response.body.toString("utf8"))
        : null;
      const output: UrlInspectOutput = {
        url: initialUrl.toString(),
        finalUrl: url.toString(),
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        contentType,
        contentLength,
        downloadedBytes: response.body.length,
        truncated: response.truncated,
        title,
        timingMs: Date.now() - startedAt,
        summary: title
          ? `${response.status} ${response.statusText}: ${title}`
          : `${response.status} ${response.statusText}`.trim(),
        retryable: response.status >= 500 || response.status === 429,
      };
      return { ok: true, output };
    }
    return {
      ok: false,
      error: urlInspectError("url_redirect_limit", "URL exceeded the redirect limit."),
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "url_inspect_failed";
    if (code === "blocked_address") {
      return {
        ok: false,
        error: urlInspectError(
          "url_address_blocked",
          "URL resolved to a non-public network address.",
        ),
      };
    }
    if (controller.signal.aborted || code === "timeout") {
      return {
        ok: false,
        error: urlInspectError(
          "url_inspect_timeout",
          `URL inspection timed out after ${timeoutMs}ms.`,
          true,
        ),
      };
    }
    return {
      ok: false,
      error: urlInspectError(
        "url_inspect_failed",
        "URL inspection failed before a response was available.",
        true,
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
};
