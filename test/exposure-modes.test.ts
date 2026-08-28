import { describe, expect, it } from "vitest";

import type { GatewayCore, VerifiedGatewayRequest } from "../src/core/gateway-core.js";

const fakeCore = (): GatewayCore => ({
  openGatewayAccount: async () => {
    throw new Error("not used by exposure test");
  },
  handle: async (request) => Object.freeze({
    requestId: request.context.requestId,
    correlationId: request.context.correlationId,
    protocol: "2.0" as const,
    data: Object.freeze({ accepted: true }),
  }),
});

const request = (): VerifiedGatewayRequest => Object.freeze({
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

describe("OpenClaw Agent-life exposure modes", () => {
  it("preserves one protocol route set across host, loopback proxy, and direct TLS modes", async () => {
    const legacyAdapter = await import("../adapter.js");
    expect("createGatewayExposure" in legacyAdapter).toBe(true);

    const { createGatewayExposure } = await import("../src/http/routes.js");
    const modes = ["host-route", "loopback-reverse-proxy", "direct-tls"] as const;
    const exposures = modes.map((mode) => createGatewayExposure(mode, {
      core: fakeCore(),
      hostVersion: "2026.7.1-2",
    }));
    const routeShape = (exposure: (typeof exposures)[number]) => exposure.routes.map((route) => ({
      path: route.path,
      auth: route.auth,
      match: route.match,
    }));

    expect(routeShape(exposures[0])).toEqual(routeShape(exposures[1]));
    expect(routeShape(exposures[1])).toEqual(routeShape(exposures[2]));
    for (const exposure of exposures) {
      const negotiate = exposure.routes.find((route) => route.path === "/agent-life/v2/negotiate");
      await expect(negotiate?.handle({ verifiedRequest: request() })).resolves.toMatchObject({
        statusCode: 200,
        body: { data: { accepted: true } },
      });
      expect(exposure.admin.remotePort).toBeNull();
    }
  });

  it("returns HOST_INCOMPATIBLE externally while leaving management read-only", async () => {
    const legacyAdapter = await import("../adapter.js");
    expect("createGatewayExposure" in legacyAdapter).toBe(true);

    const { createGatewayExposure } = await import("../src/http/routes.js");
    const { createAdminService } = await import("../src/admin/service.js");
    const exposure = createGatewayExposure("host-route", {
      core: fakeCore(),
      hostVersion: "2026.8.0",
    });
    const negotiate = exposure.routes.find((route) => route.path === "/agent-life/v2/negotiate");

    await expect(negotiate?.handle({ verifiedRequest: request() })).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { code: "HOST_INCOMPATIBLE" } },
    });
    const writes = { count: 0 };
    const admin = createAdminService({
      hostVersion: "2026.8.0",
      core: {
        ...fakeCore(),
        openGatewayAccount: async () => {
          writes.count += 1;
          throw new Error("must remain read-only");
        },
      },
    });
    await expect(admin.createAccount({ accountId: "account-a" })).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_INCOMPATIBLE" },
      readOnly: true,
    });
    expect(writes.count).toBe(0);
  });
});
