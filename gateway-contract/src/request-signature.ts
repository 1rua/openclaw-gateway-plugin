import { createHash } from "node:crypto";

const wireIdPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
// PATCH is signed exactly like the other mutating verbs; it carries the
// conversation title update defined in contract section 7.
const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
const hexDigits = /^[0-9A-Fa-f]$/;
const unreservedByte = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x2e ||
  byte === 0x5f ||
  byte === 0x7e ||
  byte === 0x2d;

const schemaInvalid = (): never => {
  throw new Error("SCHEMA_INVALID");
};

const nonCanonicalTarget = (): never => {
  throw new Error("NON_CANONICAL_TARGET");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (value: Record<string, unknown>, expected: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    schemaInvalid();
  }
};

const hexValue = (value: string): number => {
  if (!hexDigits.test(value)) schemaInvalid();
  const parsed = Number.parseInt(value, 16);
  if (!Number.isInteger(parsed)) schemaInvalid();
  return parsed;
};

const decodeComponentBytes = (component: string): Uint8Array => {
  const bytes: number[] = [];
  for (let index = 0; index < component.length; index += 1) {
    const character = component[index]!;
    if (character === "%") {
      const high = component[index + 1];
      const low = component[index + 2];
      if (high === undefined || low === undefined) schemaInvalid();
      bytes.push((hexValue(high!) << 4) | hexValue(low!));
      index += 2;
      continue;
    }
    const codePoint = character.charCodeAt(0);
    if (codePoint > 0x7f) schemaInvalid();
    bytes.push(codePoint);
  }
  return Uint8Array.from(bytes);
};

const encodeComponent = (component: string): string => {
  const bytes = decodeComponentBytes(component);
  let encoded = "";
  for (const byte of bytes) {
    encoded += unreservedByte(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
};

const assertTargetCharacters = (target: string): void => {
  for (const character of target) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 0x7f || codePoint <= 0x20 || codePoint === 0x7f) {
      schemaInvalid();
    }
  }
  if (target.includes("#")) schemaInvalid();
};

const canonicalPath = (path: string): string => {
  if (!path.startsWith("/") || path.includes("//")) schemaInvalid();
  const rawSegments = path.split("/");
  const canonicalSegments = rawSegments.map((segment, index) => {
    if (segment.length === 0 && index !== 0 && index !== rawSegments.length - 1) {
      schemaInvalid();
    }
    const decoded = decodeComponentBytes(segment);
    if (decoded.length === 0) return "";
    if (decoded.length === 1 && decoded[0] === 0x2e) schemaInvalid();
    if (decoded.length === 2 && decoded[0] === 0x2e && decoded[1] === 0x2e) {
      schemaInvalid();
    }
    if (decoded.some((byte) => byte === 0x2f || byte === 0x5c)) schemaInvalid();
    return [...decoded]
      .map((byte) =>
        unreservedByte(byte)
          ? String.fromCharCode(byte)
          : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .join("");
  });

  const result = canonicalSegments.join("/");
  if (result !== "/open-android-intelligence/v2" && result !== "/open-android-intelligence/v2/" && !result.startsWith("/open-android-intelligence/v2/")) {
    schemaInvalid();
  }
  if (result.endsWith("/") && result !== "/open-android-intelligence/v2/") schemaInvalid();
  return result;
};

type QueryPair = Readonly<{ name: string; value: string; index: number }>;

const canonicalQuery = (query: string): string => {
  if (query.length === 0 || query.includes("?")) schemaInvalid();
  const pairs: QueryPair[] = query.split("&").map((pair, index) => {
    if (pair.length === 0) schemaInvalid();
    const separator = pair.indexOf("=");
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
    if (rawName.length === 0) schemaInvalid();
    return {
      name: encodeComponent(rawName),
      value: encodeComponent(rawValue),
      index,
    };
  });

  pairs.sort((left, right) => {
    const nameOrder = Buffer.from(left.name, "ascii").compare(Buffer.from(right.name, "ascii"));
    if (nameOrder !== 0) return nameOrder;
    const valueOrder = Buffer.from(left.value, "ascii").compare(Buffer.from(right.value, "ascii"));
    if (valueOrder !== 0) return valueOrder;
    return left.index - right.index;
  });
  return pairs.map(({ name, value }) => `${name}=${value}`).join("&");
};

export const canonicalRequestTarget = (target: string): string => {
  const rawTarget = typeof target === "string" && target.length > 0 ? target : schemaInvalid();
  assertTargetCharacters(rawTarget);

  const querySeparator = rawTarget.indexOf("?");
  const path = querySeparator === -1 ? rawTarget : rawTarget.slice(0, querySeparator);
  const query = querySeparator === -1 ? undefined : rawTarget.slice(querySeparator + 1);
  const canonicalizedPath = canonicalPath(path);
  if (query === undefined) return canonicalizedPath;
  return `${canonicalizedPath}?${canonicalQuery(query)}`;
};

const assertWireId = (value: unknown): void => {
  if (typeof value !== "string" || !wireIdPattern.test(value)) schemaInvalid();
};

const assertTimestamp = (value: unknown): void => {
  const timestamp =
    typeof value === "string" && timestampPattern.test(value) ? value : schemaInvalid();
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) schemaInvalid();
};

const assertCanonicalBase64Url = (value: unknown, byteLength: number): void => {
  const encoded =
    typeof value === "string" && base64UrlPattern.test(value) ? value : schemaInvalid();
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== byteLength || decoded.toString("base64url") !== encoded) schemaInvalid();
};

export type SignedRequestMethod = (typeof methods)[number];

export type SignedRequestInput = Readonly<{
  method: SignedRequestMethod;
  target: string;
  accountId: string;
  deviceId: string;
  sessionId: string;
  requestId: string;
  timestamp: string;
  nonce: string;
  body: Uint8Array;
}>;

export const assertExactSignedRequestFields = (value: unknown): void => {
  const record = isRecord(value) ? value : schemaInvalid();
  assertExactKeys(record, [
    "method",
    "target",
    "accountId",
    "deviceId",
    "sessionId",
    "requestId",
    "timestamp",
    "nonce",
    "body",
  ]);
  if (typeof record.method !== "string" || !methods.includes(record.method as SignedRequestMethod)) {
    schemaInvalid();
  }
  if (typeof record.target !== "string") schemaInvalid();
  assertWireId(record.accountId);
  assertWireId(record.deviceId);
  assertWireId(record.sessionId);
  assertWireId(record.requestId);
  assertTimestamp(record.timestamp);
  assertCanonicalBase64Url(record.nonce, 16);
  if (!(record.body instanceof Uint8Array)) schemaInvalid();
};

export const canonicalRequestSignatureInput = (input: SignedRequestInput): Uint8Array => {
  assertExactSignedRequestFields(input);
  const target = canonicalRequestTarget(input.target);
  if (target !== input.target) nonCanonicalTarget();

  const bodyDigest = createHash("sha256").update(input.body).digest("hex");
  return new TextEncoder().encode(
    [
      "OPEN-ANDROID-INTELLIGENCE-REQUEST-V2",
      input.method,
      target,
      input.accountId,
      input.deviceId,
      input.sessionId,
      input.requestId,
      input.timestamp,
      input.nonce,
      bodyDigest,
    ].join("\n"),
  );
};
