import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  GatewayCore,
  GatewayResponse,
  VerifiedGatewayRequest,
  VerifiedRequestContext,
} from "../core/gateway-core.js";

export const OPENCLAW_HOST_API = Object.freeze({
  minVersion: "2026.7.1",
  maxVersion: "2026.7.1",
  verifiedCommit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
} as const);

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type GatewayHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type HostApiCompatibility = Readonly<{
  minVersion: string;
  maxVersion: string;
  verifiedCommit: string;
}>;

/**
 * Raw input passed to the later authentication/verification layer.
 *
 * The adapter owns request framing and bounded body collection.  It does not
 * infer identity, parse signatures, or manufacture a verified request when
 * the verifier is absent.
 */
export type GatewayRequestVerifierInput = Readonly<{
  request: IncomingMessage;
  req: IncomingMessage;
  method: GatewayHttpMethod;
  target: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawHeaders: readonly string[];
  body: Uint8Array;
}>;

export type GatewayRequestVerifier = (
  input: GatewayRequestVerifierInput,
) => VerifiedGatewayRequest | undefined | Promise<VerifiedGatewayRequest | undefined>;

export type ExposureMode = "host-route" | "loopback-reverse-proxy" | "direct-tls";

export const EXPOSURE_MODES: readonly ExposureMode[] = Object.freeze([
  "host-route",
  "loopback-reverse-proxy",
  "direct-tls",
]);

export type GatewayRouteRequest = Readonly<{
  /** Internal seam for callers that already hold a verified request. */
  verifiedRequest?: VerifiedGatewayRequest;
  method?: string;
  target?: string;
  body?: unknown;
  context?: VerifiedRequestContext;
  idempotencyKey?: string;
  lastEventId?: string;
  now?: Date;
}>;

export type GatewayHttpResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: GatewayResponse;
}>;

export type GatewayHttpRoute = Readonly<{
  path: string;
  auth: "plugin";
  match: "exact" | "prefix";
  /** Internal verified-request seam used by focused Core tests. */
  handle: (request: GatewayRouteRequest) => Promise<GatewayHttpResponse>;
  /** Exact OpenClaw raw Node HTTP handler shape. */
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<boolean | void> | boolean | void;
}>;

export type OpenClawPluginHttpRouteParams = Readonly<{
  path: string;
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<boolean | void> | boolean | void;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
}>;

/** Compatibility export retained for the adapter barrel. */
export type OpenClawHttpRouteRegistration = OpenClawPluginHttpRouteParams;

export type GatewayRouteServices = Readonly<{
  core: GatewayCore;
  hostVersion?: string;
  hostApi?: HostApiCompatibility;
  verifyRequest?: GatewayRequestVerifier;
  maxBodyBytes?: number;
}>;

export type GatewayExposure = Readonly<{
  mode: ExposureMode;
  routes: readonly GatewayHttpRoute[];
  listener: Readonly<Record<string, unknown>>;
  admin: Readonly<{
    localOnly: true;
    remotePort: null;
  }>;
}>;

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

type ParsedVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
  suffix: string;
}>;

const parseVersion = (value: unknown): ParsedVersion | undefined => {
  if (typeof value !== "string") return undefined;
  const match = versionPattern.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const suffix = match[4] ?? "";
  return Object.freeze({
    major,
    minor,
    patch,
    // OpenClaw correction tags such as 2026.7.1-2 carry the same API
    // surface as the base 2026.7.1 runtime package.
    suffix: /^\d+$/u.test(suffix) ? "" : suffix,
  });
};

const compareParsedVersions = (left: ParsedVersion, right: ParsedVersion): number => {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.suffix === right.suffix) return 0;
  if (left.suffix.length === 0) return 1;
  if (right.suffix.length === 0) return -1;
  return left.suffix < right.suffix ? -1 : 1;
};

const compareVersions = (left: unknown, right: unknown): number => {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (parsedLeft === undefined || parsedRight === undefined) return Number.NaN;
  return compareParsedVersions(parsedLeft, parsedRight);
};

const validHostApiRange = (hostApi: HostApiCompatibility): boolean => {
  if (!/^[0-9a-f]{40}$/iu.test(hostApi.verifiedCommit)) return false;
  const minimum = parseVersion(hostApi.minVersion);
  const maximum = parseVersion(hostApi.maxVersion);
  return minimum !== undefined
    && maximum !== undefined
    && compareParsedVersions(minimum, maximum) <= 0;
};

export const isHostApiCompatible = (
  hostVersion: string | undefined,
  hostApi: HostApiCompatibility = OPENCLAW_HOST_API,
): boolean => {
  if (hostVersion === undefined || !validHostApiRange(hostApi)) return false;
  const minimum = compareVersions(hostVersion, hostApi.minVersion);
  const maximum = compareVersions(hostVersion, hostApi.maxVersion);
  return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 0 && maximum <= 0;
};

/**
 * Wire error code to HTTP status. Codes absent from this map are caller errors
 * and answer 400, the contract's default for malformed input.
 */
const ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  HOST_INCOMPATIBLE: 503,
  AUTHENTICATION_REQUIRED: 401,
  AUTHENTICATION_FAILED: 401,
  REFRESH_REUSED: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  SIGNATURE_INVALID: 401,
  NON_CANONICAL_TARGET: 401,
  REQUEST_REPLAYED: 401,
  CLOCK_SKEWED: 401,
  ACCOUNT_NOT_FOUND: 404,
  PROTOCOL_INCOMPATIBLE: 406,
  IDEMPOTENCY_CONFLICT: 409,
  CURSOR_CONFLICT: 409,
  CURSOR_EXPIRED: 410,
  REQUEST_BODY_TOO_LARGE: 413,
  RATE_LIMITED: 429,
});

const errorStatus = (response: GatewayResponse): number => {
  const code = response.error?.code;
  if (code !== undefined && ERROR_STATUS[code] !== undefined) return ERROR_STATUS[code]!;
  if (response.error !== undefined) return 400;
  return 200;
};

/**
 * Endpoints contract §4/§5 run *before* authentication. They carry no verified
 * identity, so they never reach the verifier and never receive one.
 */
const PRE_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/open-android-intelligence/v2/negotiate",
  "/open-android-intelligence/v2/sessions/password",
  "/open-android-intelligence/v2/sessions/refresh",
  "/open-android-intelligence/v2/sessions/current",
]);

const isPreAuthRequest = (method: GatewayHttpMethod, target: string): boolean => {
  const path = target.split("?")[0] ?? target;
  if (!PRE_AUTH_PATHS.has(path)) return false;
  return path === "/open-android-intelligence/v2/sessions/current" ? method === "DELETE" : method === "POST";
};

const flattenedHeaders = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> => {
  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const single = headerValue(value);
    if (single !== undefined) flattened[name.toLowerCase()] = single;
  }
  return Object.freeze(flattened);
};

/** Parses a pre-auth JSON body; anything unparseable is a caller error. */
const decodePreAuthBody = (
  body: Uint8Array,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): unknown => {
  if (body.byteLength === 0) return undefined;
  const contentType = String(headerValue(headers["content-type"]) ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return body;
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    throw new Error("SCHEMA_INVALID");
  }
};

const responseIdentity = (request: GatewayRouteRequest): Readonly<{
  requestId: string;
  correlationId: string;
}> => {
  // A pre-auth request has no verified identity yet; naming one would claim an
  // authentication that never happened.
  const context = request.verifiedRequest?.context;
  return {
    requestId: context?.requestId ?? "open-android-intelligence-route",
    correlationId: context?.correlationId ?? "open-android-intelligence-route",
  };
};

const failureResponse = (
  request: GatewayRouteRequest,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayResponse => {
  const identity = responseIdentity(request);
  return Object.freeze({
    requestId: identity.requestId,
    correlationId: identity.correlationId,
    protocol: "2.0" as const,
    error: Object.freeze({
      code,
      message: code,
      retryable: false,
      retryAfterSeconds: null,
      details,
    }),
  });
};

const toVerifiedRequest = (
  routePath: string,
  request: GatewayRouteRequest,
): VerifiedGatewayRequest | undefined => {
  if (request.verifiedRequest !== undefined) return request.verifiedRequest;
  if (request.context === undefined) return undefined;
  // `PATCH` is the conversation title update (contract section 7); every other
  // verb stays out of the verified-request seam.
  if (
    request.method !== "GET"
    && request.method !== "POST"
    && request.method !== "PUT"
    && request.method !== "DELETE"
    && request.method !== "PATCH"
  ) {
    return undefined;
  }
  return Object.freeze({
    context: request.context,
    method: request.method,
    target: request.target ?? routePath,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    ...(request.lastEventId === undefined ? {} : { lastEventId: request.lastEventId }),
    ...(request.now === undefined ? {} : { now: request.now }),
  });
};

const responseHeaders = Object.freeze({
  "content-type": "application/json; charset=utf-8",
});

const maxBodyBytes = (value: number | undefined): number => (
  value === undefined || !Number.isSafeInteger(value) || value < 0
    ? DEFAULT_MAX_BODY_BYTES
    : value
);

const headerValue = (value: string | string[] | undefined): string | undefined => (
  Array.isArray(value) ? value[0] : value
);

const asBodyChunk = (value: unknown): Uint8Array => {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return value;
  throw new Error("REQUEST_BODY_INVALID");
};

const readRequestBody = async (request: IncomingMessage, limit: number): Promise<Uint8Array> => {
  const contentLength = headerValue(request.headers["content-length"]);
  if (contentLength !== undefined) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) throw new Error("REQUEST_BODY_INVALID");
    if (declaredLength > limit) throw new Error("REQUEST_BODY_TOO_LARGE");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = asBodyChunk(value);
    length += chunk.byteLength;
    if (length > limit) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return new Uint8Array();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
};

const rawRequestTarget = (request: IncomingMessage): string | undefined => {
  const target = request.url;
  return typeof target === "string" && target.startsWith("/") ? target : undefined;
};

const rawRequestMethod = (request: IncomingMessage): GatewayHttpMethod | undefined => {
  if (
    request.method === "GET"
    || request.method === "POST"
    || request.method === "PUT"
    || request.method === "DELETE"
    || request.method === "PATCH"
  ) {
    return request.method;
  }
  return undefined;
};

type ResolvedGatewayRouteServices = Readonly<{
  core: GatewayCore;
  hostVersion: string | undefined;
  hostApi: HostApiCompatibility;
  verifyRequest?: GatewayRequestVerifier;
  maxBodyBytes: number;
}>;

const incompatibleResponse = (
  request: GatewayRouteRequest,
  services: ResolvedGatewayRouteServices,
): GatewayHttpResponse => Object.freeze({
  statusCode: 503,
  headers: responseHeaders,
  body: failureResponse(request, "HOST_INCOMPATIBLE", Object.freeze({
    hostVersion: services.hostVersion ?? null,
    minVersion: services.hostApi.minVersion,
    maxVersion: services.hostApi.maxVersion,
    verifiedCommit: services.hostApi.verifiedCommit,
  })),
});

const authenticationRequiredResponse = (
  request: GatewayRouteRequest,
): GatewayHttpResponse => Object.freeze({
  statusCode: 401,
  headers: responseHeaders,
  body: failureResponse(request, "AUTHENTICATION_REQUIRED"),
});

const rawFailureResponse = (
  request: GatewayRouteRequest,
  code: string,
): GatewayHttpResponse => {
  const body = failureResponse(request, code);
  return Object.freeze({ statusCode: errorStatus(body), headers: responseHeaders, body });
};

const createRoute = (
  routePath: string,
  match: "exact" | "prefix",
  services: ResolvedGatewayRouteServices,
): GatewayHttpRoute => {
  const handle = async (request: GatewayRouteRequest): Promise<GatewayHttpResponse> => {
    if (!isHostApiCompatible(services.hostVersion, services.hostApi)) return incompatibleResponse(request, services);

    const verifiedRequest = toVerifiedRequest(routePath, request);
    if (verifiedRequest === undefined) return authenticationRequiredResponse(request);

    const body = await services.core.handle(verifiedRequest);
    return Object.freeze({
      statusCode: errorStatus(body),
      headers: responseHeaders,
      body,
    });
  };

  const handleRaw = async (request: IncomingMessage): Promise<GatewayHttpResponse> => {
    const emptyRequest: GatewayRouteRequest = {};
    if (!isHostApiCompatible(services.hostVersion, services.hostApi)) return incompatibleResponse(emptyRequest, services);

    const method = rawRequestMethod(request);
    const target = rawRequestTarget(request);
    if (method === undefined || target === undefined) return authenticationRequiredResponse(emptyRequest);

    let body: Uint8Array;
    try {
      body = await readRequestBody(request, services.maxBodyBytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : "REQUEST_BODY_INVALID";
      return rawFailureResponse(emptyRequest, code === "REQUEST_BODY_TOO_LARGE" ? code : "REQUEST_BODY_INVALID");
    }

    let verifiedRequest: VerifiedGatewayRequest | undefined;
    if (isPreAuthRequest(method, target)) {
      // No verifier is involved: these endpoints exist to establish the session
      // the verifier will later require.
      let preAuthBody: unknown;
      try {
        preAuthBody = decodePreAuthBody(body, request.headers);
      } catch (error) {
        return rawFailureResponse(emptyRequest, error instanceof Error ? error.message : "SCHEMA_INVALID");
      }
      verifiedRequest = Object.freeze({
        method,
        target,
        ...(preAuthBody === undefined ? {} : { body: preAuthBody }),
        headers: flattenedHeaders(request.headers),
      });
    } else {
      if (services.verifyRequest === undefined) return authenticationRequiredResponse(emptyRequest);
      try {
        verifiedRequest = await services.verifyRequest({
          request,
          req: request,
          method,
          target,
          headers: Object.freeze({ ...request.headers }),
          rawHeaders: Object.freeze([...request.rawHeaders]),
          body,
        });
      } catch {
        verifiedRequest = undefined;
      }
      if (verifiedRequest === undefined) return authenticationRequiredResponse(emptyRequest);
    }

    const response = await services.core.handle(verifiedRequest);
    return Object.freeze({
      statusCode: errorStatus(response),
      headers: responseHeaders,
      body: response,
    });
  };

  return Object.freeze({
    path: routePath,
    auth: "plugin" as const,
    match,
    handle,
    handler: async (request, response): Promise<boolean> => {
      let result: GatewayHttpResponse;
      try {
        result = await handleRaw(request);
      } catch {
        result = rawFailureResponse({}, "INTERNAL_ERROR");
      }
      response.statusCode = result.statusCode;
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
      response.end(JSON.stringify(result.body));
      return true;
    },
  });
};

const routeDefinitions: readonly Readonly<{
  path: string;
  match: "exact" | "prefix";
}>[] = Object.freeze([
  Object.freeze({ path: "/open-android-intelligence/v2/negotiate", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/sessions/password", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/sessions/refresh", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/sessions/current", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/commands", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/events", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/conversations", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/conversations/", match: "prefix" }),
  Object.freeze({ path: "/open-android-intelligence/v2/attachments", match: "exact" }),
  Object.freeze({ path: "/open-android-intelligence/v2/attachments/", match: "prefix" }),
  Object.freeze({ path: "/open-android-intelligence/v2/device-requests/", match: "prefix" }),
]);

export const createGatewayRoutes = (services: GatewayRouteServices): readonly GatewayHttpRoute[] => {
  const hostApi = services.hostApi ?? OPENCLAW_HOST_API;
  const resolvedServices: ResolvedGatewayRouteServices = {
    core: services.core,
    hostVersion: services.hostVersion,
    hostApi,
    verifyRequest: services.verifyRequest,
    maxBodyBytes: maxBodyBytes(services.maxBodyBytes),
  };
  return Object.freeze(routeDefinitions.map(({ path, match }) => createRoute(path, match, resolvedServices)));
};

export const gatewayRoutes = createGatewayRoutes;

export const createGatewayExposure = (
  mode: ExposureMode,
  services: GatewayRouteServices,
): GatewayExposure => {
  if (!EXPOSURE_MODES.includes(mode)) throw new Error("EXPOSURE_MODE_INVALID");
  const routes = createGatewayRoutes(services);
  const listener = mode === "host-route"
    ? Object.freeze({ kind: "host-route", ownedBy: "openclaw-gateway", active: true })
    : mode === "loopback-reverse-proxy"
      ? Object.freeze({ kind: "loopback", bind: "127.0.0.1", tlsTerminatedBy: "user-configured-reverse-proxy", active: false })
      : Object.freeze({ kind: "direct-tls", bind: "127.0.0.1", requiresExplicitCertificate: true, active: false });
  return Object.freeze({
    mode,
    routes,
    listener,
    admin: Object.freeze({ localOnly: true as const, remotePort: null }),
  });
};
