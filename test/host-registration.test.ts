import { describe, expect, it } from "vitest";

import type { GatewayCore, VerifiedGatewayRequest } from "../src/core/gateway-core.js";

type RegisteredRoute = Readonly<{
  path: string;
  auth: string;
  match: string;
  handle?: (request: unknown) => Promise<unknown>;
  handler?: (request: unknown, response: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    end: (body?: string) => void;
  }) => Promise<boolean>;
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
      data: Object.freeze({ accepted: true }),
    });
  },
});

const fakeOpenClawApi = (core: GatewayCore) => {
  const channels: unknown[] = [];
  const httpRoutes: RegisteredRoute[] = [];
  const adminPanels: unknown[] = [];
  return {
    version: "2026.7.1",
    gatewayCore: core,
    channels,
    httpRoutes,
    adminPanels,
    registerChannel: (registration: unknown): void => { channels.push(registration); },
    registerHttpRoute: (route: unknown): void => { httpRoutes.push(route as RegisteredRoute); },
    registerAdminPanel: (panel: unknown): void => { adminPanels.push(panel); },
  };
};

const verifiedRequest = (): VerifiedGatewayRequest => Object.freeze({
  context: Object.freeze({
    accountId: "account-a",
    deviceId: "device-a",
    sessionId: "session-a",
    requestId: "request-a",
    correlationId: "correlation-a",
    pairingGeneration: 1,
    grantRevision: 1,
  }),
  method: "POST",
  target: "/agent-life/v2/negotiate",
  body: Object.freeze({}),
});

describe("OpenClaw Agent-life registration", () => {
  it("replaces the fixture-only adapter with the real channel and HTTP registration shape", async () => {
    const legacyAdapter = await import("../adapter.js");
    expect("registerAgentLifeGateway" in legacyAdapter).toBe(true);

    const { registerAgentLifeGateway } = await import("../src/host/channel-adapter.js");
    const seen: { request?: VerifiedGatewayRequest } = {};
    const api = fakeOpenClawApi(fakeCore(seen));

    registerAgentLifeGateway(api);

    expect(api.channels).toHaveLength(1);
    expect(api.channels[0]).toMatchObject({
      plugin: { id: "agent-life-gateway" },
    });
    expect(api.httpRoutes.map((route) => route.path)).toContain("/agent-life/v2/negotiate");

    const negotiate = api.httpRoutes.find((route) => route.path === "/agent-life/v2/negotiate");
    expect(negotiate?.auth).toBe("plugin");
    expect(negotiate?.match).toBe("exact");
    expect(negotiate?.handler).toBeTypeOf("function");
    const handler = negotiate?.handler;
    if (handler === undefined) return;
    let responseBody = "";
    const response = {
      statusCode: 0,
      setHeader: (): void => undefined,
      end: (body?: string): void => { responseBody = body ?? ""; },
    };
    await expect(handler({ verifiedRequest: verifiedRequest() }, response)).resolves.toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({ data: { accepted: true } });
    expect(seen.request).toEqual(verifiedRequest());
    expect(api.adminPanels).toHaveLength(1);
  });
});
