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

export type HostApiCompatibility = Readonly<{
  minVersion: string;
  maxVersion: string;
  verifiedCommit: string;
}>;

export type ExposureMode = "host-route" | "loopback-reverse-proxy" | "direct-tls";

export const EXPOSURE_MODES: readonly ExposureMode[] = Object.freeze([
  "host-route",
  "loopback-reverse-proxy",
  "direct-tls",
]);

export type GatewayRouteRequest = Readonly<{
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

export type OpenClawHttpResponse = {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  end?: (body?: string) => void;
  json?: (body: unknown) => void;
};

export type OpenClawHttpRequest = GatewayRouteRequest & Readonly<{
  url?: string;
}>;

export type GatewayHttpRoute = Readonly<{
  path: string;
  auth: "plugin";
  match: "exact" | "prefix";
  handle: (request: GatewayRouteRequest) => Promise<GatewayHttpResponse>;
  handler: (request: OpenClawHttpRequest, response: OpenClawHttpResponse) => Promise<boolean>;
}>;

export type OpenClawHttpRouteRegistration = Readonly<{
  path: string;
  auth: "plugin";
  match: "exact" | "prefix";
  handler: (request: OpenClawHttpRequest, response: OpenClawHttpResponse) => Promise<boolean>;
}>;

export type GatewayRouteServices = Readonly<{
  core: GatewayCore;
  hostVersion?: string;
  hostApi?: HostApiCompatibility;
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

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

type ParsedVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
  suffix: string;
}>;

const parseVersion = (value: string): ParsedVersion | undefined => {
  const match = versionPattern.exec(value);
  if (match === null) return undefined;
  const suffix = match[4] ?? "";
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // OpenClaw correction tags such as 2026.7.1-2 carry the same API
    // surface as the base 2026.7.1 runtime package.
    suffix: /^\d+$/.test(suffix) ? "" : suffix,
  });
};

const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return Number.NaN;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.suffix === b.suffix) return 0;
  if (a.suffix.length === 0) return 1;
  if (b.suffix.length === 0) return -1;
  return a.suffix < b.suffix ? -1 : 1;
};

export const isHostApiCompatible = (
  hostVersion: string,
  hostApi: HostApiCompatibility = OPENCLAW_HOST_API,
): boolean => {
  const minimum = compareVersions(hostVersion, hostApi.minVersion);
  const maximum = compareVersions(hostVersion, hostApi.maxVersion);
  return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum >= 0 && maximum <= 0;
};

const errorStatus = (response: GatewayResponse): number => {
  if (response.error?.code === "HOST_INCOMPATIBLE") return 503;
  if (response.error?.code === "AUTHENTICATION_REQUIRED") return 401;
  if (response.error !== undefined) return 400;
  return 200;
};

const responseIdentity = (request: GatewayRouteRequest): Readonly<{
  requestId: string;
  correlationId: string;
}> => ({
  requestId: request.verifiedRequest?.context.requestId ?? "agent-life-route",
  correlationId: request.verifiedRequest?.context.correlationId ?? "agent-life-route",
});

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
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE") {
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

const createRoute = (
  routePath: string,
  match: "exact" | "prefix",
  services: Required<Pick<GatewayRouteServices, "core" | "hostVersion" | "hostApi">>,
): GatewayHttpRoute => {
  const handle = async (request: GatewayRouteRequest): Promise<GatewayHttpResponse> => {
    if (!isHostApiCompatible(services.hostVersion, services.hostApi)) {
      return Object.freeze({
        statusCode: 503,
        headers: responseHeaders,
        body: failureResponse(request, "HOST_INCOMPATIBLE", Object.freeze({
          hostVersion: services.hostVersion,
          minVersion: services.hostApi.minVersion,
          maxVersion: services.hostApi.maxVersion,
          verifiedCommit: services.hostApi.verifiedCommit,
        })),
      });
    }

    const verifiedRequest = toVerifiedRequest(routePath, request);
    if (verifiedRequest === undefined) {
      return Object.freeze({
        statusCode: 401,
        headers: responseHeaders,
        body: failureResponse(request, "AUTHENTICATION_REQUIRED"),
      });
    }

    const body = await services.core.handle(verifiedRequest);
    return Object.freeze({
      statusCode: errorStatus(body),
      headers: responseHeaders,
      body,
    });
  };

  return Object.freeze({
    path: routePath,
    auth: "plugin" as const,
    match,
    handle,
    handler: async (request, response): Promise<boolean> => {
      const result = await handle(request);
      response.statusCode = result.statusCode;
      for (const [name, value] of Object.entries(result.headers)) response.setHeader?.(name, value);
      if (response.json !== undefined) response.json(result.body);
      else response.end?.(JSON.stringify(result.body));
      return true;
    },
  });
};

const routeDefinitions: readonly Readonly<{
  path: string;
  match: "exact" | "prefix";
}>[] = Object.freeze([
  Object.freeze({ path: "/agent-life/v2/negotiate", match: "exact" }),
  Object.freeze({ path: "/agent-life/v2/events", match: "exact" }),
  Object.freeze({ path: "/agent-life/v2/conversations", match: "exact" }),
  Object.freeze({ path: "/agent-life/v2/conversations/", match: "prefix" }),
  Object.freeze({ path: "/agent-life/v2/attachments", match: "exact" }),
  Object.freeze({ path: "/agent-life/v2/attachments/", match: "prefix" }),
  Object.freeze({ path: "/agent-life/v2/device-requests/", match: "prefix" }),
]);

export const createGatewayRoutes = (services: GatewayRouteServices): readonly GatewayHttpRoute[] => {
  const hostApi = services.hostApi ?? OPENCLAW_HOST_API;
  const hostVersion = services.hostVersion ?? hostApi.maxVersion;
  const resolvedServices = { core: services.core, hostVersion, hostApi } as const;
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
