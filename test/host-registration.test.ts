import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { GatewayCore, VerifiedGatewayRequest } from "../src/core/gateway-core.js";
import type { OpenClawCliRegistrationOptions, OpenClawCliRegistrar } from "../src/admin/cli.js";

type GatewayRequestVerifierInput = Readonly<{
  method: "GET" | "POST" | "PUT" | "DELETE";
  target: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawHeaders: readonly string[];
  body: Uint8Array;
}>;

type RegisteredRoute = Readonly<{
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
  handler?: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<boolean | void> | boolean | void;
}>;

type CliCapture = Readonly<{
  registrar: OpenClawCliRegistrar;
  options: OpenClawCliRegistrationOptions | undefined;
}>;

type ApiVersionOptions = Readonly<{
  hostVersion?: string;
  pluginVersion?: string;
}>;

const fakeCore = (seen: { request?: VerifiedGatewayRequest }): GatewayCore => Object.freeze({
  openGatewayAccount: async () => {
    throw new Error("not used by registration");
  },
  handle: async (request) => {
    seen.request = request;
    return Object.freeze({
      requestId: request.context.requestId,
      correlationId: request.context.correlationId,
      protocol: "2.0" as const,
      data: Object.freeze({ accepted: true, target: request.target }),
    });
  },
});

const verifiedRequest = (input: GatewayRequestVerifierInput): VerifiedGatewayRequest => Object.freeze({
  context: Object.freeze({
    accountId: "account-a",
    deviceId: "device-a",
    sessionId: "session-a",
    requestId: "request-a",
    correlationId: "correlation-a",
    pairingGeneration: 1,
    grantRevision: 1,
  }),
  method: input.method,
  target: input.target,
  body: Object.freeze({ accepted: true }),
});

const rawRequest = (
  url: string,
  body = "{}",
  method: "GET" | "POST" | "PUT" | "DELETE" = "POST",
): IncomingMessage => Object.assign(
  Readable.from(body.length === 0 ? [] : [Buffer.from(body, "utf8")]),
  {
    method,
    url,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      authorization: "Bearer redacted-test-token",
    },
    rawHeaders: ["content-type", "application/json", "authorization", "Bearer redacted-test-token"],
  },
) as unknown as IncomingMessage;

const rawResponse = (): {
  response: ServerResponse;
  state: { statusCode: number; headers: Record<string, string>; body: string };
} => {
  const state: { statusCode: number; headers: Record<string, string>; body: string } = {
    statusCode: 0,
    headers: {},
    body: "",
  };
  const response = {
    statusCode: state.statusCode,
    setHeader: (name: string, value: string): void => {
      state.headers[name.toLowerCase()] = value;
    },
    end: (body?: string): void => {
      state.body = body ?? "";
    },
  } as unknown as ServerResponse;
  Object.defineProperty(response, "statusCode", {
    get: () => state.statusCode,
    set: (value: number) => { state.statusCode = value; },
  });
  return { response, state };
};

const fakeOpenClawApi = (
  core: GatewayCore,
  verifyRequest?: (input: GatewayRequestVerifierInput) => VerifiedGatewayRequest | undefined,
  maxBodyBytes?: number,
  versionOptions: ApiVersionOptions = { hostVersion: "2026.7.1" },
) => {
  const channels: unknown[] = [];
  const httpRoutes: RegisteredRoute[] = [];
  const adminPanels: unknown[] = [];
  const cliCaptures: CliCapture[] = [];
  const gatewayMethods: string[] = [];
  return {
    version: versionOptions.pluginVersion ?? "plugin-1.0.0",
    ...(versionOptions.hostVersion === undefined ? {} : { hostVersion: versionOptions.hostVersion }),
    gatewayCore: core,
    verifyRequest,
    maxBodyBytes,
    channels,
    httpRoutes,
    adminPanels,
    cliCaptures,
    gatewayMethods,
    registerChannel: (registration: unknown): void => { channels.push(registration); },
    registerHttpRoute: (route: unknown): void => { httpRoutes.push(route as RegisteredRoute); },
    registerAdminPanel: (panel: unknown): void => { adminPanels.push(panel); },
    registerGatewayMethod: (name: string): void => { gatewayMethods.push(name); },
    registerCli: (
      registrar: OpenClawCliRegistrar,
      options?: OpenClawCliRegistrationOptions,
    ): void => { cliCaptures.push({ registrar, options }); },
  };
};

describe("OpenClaw Agent-life registration", () => {
  it("registers the complete pinned channel plugin surface and raw HTTP route", async () => {
    const legacyAdapter = await import("../adapter.js");
    expect("registerAgentLifeGateway" in legacyAdapter).toBe(true);

    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const seen: { request?: VerifiedGatewayRequest } = {};
    const verifierInputs: GatewayRequestVerifierInput[] = [];
    const api = fakeOpenClawApi(fakeCore(seen), (input) => {
      verifierInputs.push(input);
      return verifiedRequest(input);
    });

    registerAgentLifeGateway(api);

    expect(api.channels).toHaveLength(1);
    const channel = (api.channels[0] as { plugin: Record<string, unknown> }).plugin;
    expect(channel).toMatchObject({
      id: "agent-life-gateway",
      meta: {
        id: "agent-life-gateway",
        label: "Agent-life Gateway",
        selectionLabel: "Agent-life Gateway",
        docsPath: "/gateway/agent-life",
        blurb: "Gateway Protocol v2 over the OpenClaw Gateway host",
      },
      capabilities: { chatTypes: ["direct"], media: true },
      gatewayMethods: [],
      gatewayMethodDescriptors: [],
    });
    expect(channel.config).toMatchObject({
      listAccountIds: expect.any(Function),
      resolveAccount: expect.any(Function),
    });
    expect((channel.config as { listAccountIds: (config: unknown) => string[] }).listAccountIds({})).toEqual([]);

    expect(api.httpRoutes.map((route) => route.path)).toContain("/agent-life/v2/negotiate");
    const negotiate = api.httpRoutes.find((route) => route.path === "/agent-life/v2/negotiate");
    expect(negotiate?.auth).toBe("plugin");
    expect(negotiate?.match).toBe("exact");
    expect(negotiate?.handler).toBeTypeOf("function");
    const handler = negotiate?.handler;
    if (handler === undefined) throw new Error("registered negotiate handler missing");

    const { response, state } = rawResponse();
    await expect(handler(rawRequest("/agent-life/v2/negotiate?mode=initial"), response)).resolves.toBe(true);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ data: { accepted: true } });
    expect(verifierInputs).toHaveLength(1);
    expect(verifierInputs[0]).toMatchObject({
      method: "POST",
      target: "/agent-life/v2/negotiate?mode=initial",
    });
    expect(Buffer.from(verifierInputs[0].body).toString("utf8")).toBe("{}");
    expect(seen.request?.target).toBe("/agent-life/v2/negotiate?mode=initial");
  });

  it("fails closed at the raw host boundary when no verifier is supplied", async () => {
    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const seen: { request?: VerifiedGatewayRequest } = {};
    const api = fakeOpenClawApi(fakeCore(seen));

    registerAgentLifeGateway(api);
    const negotiate = api.httpRoutes.find((route) => route.path === "/agent-life/v2/negotiate");
    if (negotiate?.handler === undefined) throw new Error("registered negotiate handler missing");

    const { response, state } = rawResponse();
    await expect(negotiate.handler(rawRequest("/agent-life/v2/negotiate"), response)).resolves.toBe(true);
    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
    expect(seen.request).toBeUndefined();
  });

  it("rejects a raw body over the configured limit before verification or Core", async () => {
    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const seen: { request?: VerifiedGatewayRequest } = {};
    let verifierCalls = 0;
    const api = fakeOpenClawApi(fakeCore(seen), () => {
      verifierCalls += 1;
      return undefined;
    }, 1);

    registerAgentLifeGateway(api);
    const negotiate = api.httpRoutes.find((route) => route.path === "/agent-life/v2/negotiate");
    if (negotiate?.handler === undefined) throw new Error("registered negotiate handler missing");

    const { response, state } = rawResponse();
    await expect(negotiate.handler(rawRequest("/agent-life/v2/negotiate", "{}"), response)).resolves.toBe(true);
    expect(state.statusCode).toBe(413);
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: "REQUEST_BODY_TOO_LARGE" } });
    expect(verifierCalls).toBe(0);
    expect(seen.request).toBeUndefined();
  });

  it("uses only the local panel and real CLI registrar without a Gateway RPC admin fallback", async () => {
    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const api = fakeOpenClawApi(fakeCore({}));

    registerAgentLifeGateway(api);

    expect(api.gatewayMethods).toEqual([]);
    expect(api.adminPanels).toHaveLength(1);
    expect(api.cliCaptures).toHaveLength(1);
    expect(api.cliCaptures[0].options).toEqual({
      parentPath: [],
      commands: ["agent-life"],
      descriptors: [{
        name: "agent-life",
        description: "Manage Agent-life Gateway accounts",
        hasSubcommands: true,
      }],
    });
  });

  it("rejects an unknown host version before exposing a usable route", async () => {
    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const seen: { request?: VerifiedGatewayRequest } = {};
    const api = fakeOpenClawApi(fakeCore(seen), undefined, undefined, {
      hostVersion: undefined,
      pluginVersion: "2026.7.1",
    });

    registerAgentLifeGateway(api);
    const negotiate = api.httpRoutes.find((route) => route.path === "/agent-life/v2/negotiate");
    if (negotiate?.handler === undefined) throw new Error("registered negotiate handler missing");

    const { response, state } = rawResponse();
    await expect(negotiate.handler(rawRequest("/agent-life/v2/negotiate"), response)).resolves.toBe(true);
    expect(state.statusCode).toBe(503);
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: "HOST_INCOMPATIBLE" } });
    expect(seen.request).toBeUndefined();
    expect((api.adminPanels[0] as { readOnly: boolean }).readOnly).toBe(true);
  });

  it("accepts an explicit trusted hostVersion even when plugin metadata has another version", async () => {
    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const seen: { request?: VerifiedGatewayRequest } = {};
    const api = fakeOpenClawApi(fakeCore(seen), (input) => verifiedRequest(input), undefined, {
      hostVersion: "2026.7.1",
      pluginVersion: "plugin-1.0.0",
    });

    registerAgentLifeGateway(api);
    const negotiate = api.httpRoutes.find((route) => route.path === "/agent-life/v2/negotiate");
    if (negotiate?.handler === undefined) throw new Error("registered negotiate handler missing");

    const { response, state } = rawResponse();
    await expect(negotiate.handler(rawRequest("/agent-life/v2/negotiate"), response)).resolves.toBe(true);
    expect(state.statusCode).toBe(200);
    expect(seen.request?.target).toBe("/agent-life/v2/negotiate");
    expect((api.adminPanels[0] as { readOnly: boolean }).readOnly).toBe(false);
  });

  it("rejects an invalid explicit hostVersion even when plugin metadata looks compatible", async () => {
    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const seen: { request?: VerifiedGatewayRequest } = {};
    const api = fakeOpenClawApi(fakeCore(seen), undefined, undefined, {
      hostVersion: "not-a-version",
      pluginVersion: "2026.7.1",
    });

    registerAgentLifeGateway(api);
    const negotiate = api.httpRoutes.find((route) => route.path === "/agent-life/v2/negotiate");
    if (negotiate?.handler === undefined) throw new Error("registered negotiate handler missing");

    const { response, state } = rawResponse();
    await expect(negotiate.handler(rawRequest("/agent-life/v2/negotiate"), response)).resolves.toBe(true);
    expect(state.statusCode).toBe(503);
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: "HOST_INCOMPATIBLE" } });
    expect(seen.request).toBeUndefined();
  });
});
