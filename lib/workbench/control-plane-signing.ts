export const facadeSignatureHeader = "x-assistant-mk1-signature-v1";
export const facadeSignatureTimestampHeader = "x-assistant-mk1-signature-timestamp";
export const facadeSignatureNonceHeader = "x-assistant-mk1-signature-nonce";
export const facadeContentSha256Header = "x-assistant-mk1-content-sha256";

const textEncoder = new TextEncoder();

const excludedSignedHeaders = new Set([
  facadeSignatureHeader,
  facadeSignatureTimestampHeader,
  facadeSignatureNonceHeader,
  facadeContentSha256Header,
]);

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const sha256Base64Url = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
};

export const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
};

const normalizeHeaders = (headers: Headers | Record<string, string>) => {
  const entries: Array<[string, string]> = [];
  if (headers instanceof Headers) {
    headers.forEach((value, key) => entries.push([key.toLowerCase(), value.trim()]));
  } else {
    for (const [key, value] of Object.entries(headers)) {
      entries.push([key.toLowerCase(), value.trim()]);
    }
  }
  return entries;
};

export const canonicalAssistantHeaders = (headers: Headers | Record<string, string>) =>
  normalizeHeaders(headers)
    .filter(([key]) => key.startsWith("x-assistant-mk1-") && !excludedSignedHeaders.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");

export const canonicalFacadeRequest = (input: {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  headers: Headers | Record<string, string>;
}) =>
  [
    "v1",
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.timestamp,
    input.nonce,
    input.bodyHash,
    canonicalAssistantHeaders(input.headers),
  ].join("\n");

export const hmacSha256Base64Url = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
};

export const signFacadeRequest = async (input: {
  secret: string;
  method: string;
  pathWithQuery: string;
  body?: string;
  headers: Record<string, string>;
  timestamp?: string;
  nonce?: string;
}) => {
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? crypto.randomUUID();
  const bodyHash = await sha256Base64Url(input.body ?? "");
  const headers = {
    ...input.headers,
    [facadeSignatureTimestampHeader]: timestamp,
    [facadeSignatureNonceHeader]: nonce,
    [facadeContentSha256Header]: bodyHash,
  };
  const canonical = canonicalFacadeRequest({
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    timestamp,
    nonce,
    bodyHash,
    headers,
  });
  return {
    [facadeSignatureTimestampHeader]: timestamp,
    [facadeSignatureNonceHeader]: nonce,
    [facadeContentSha256Header]: bodyHash,
    [facadeSignatureHeader]: await hmacSha256Base64Url(input.secret, canonical),
  };
};
