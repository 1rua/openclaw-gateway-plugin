import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { GatewayCore, VerifiedGatewayRequest } from "../src/core/gateway-core.js";

type GatewayRequestVerifierInput = Readonly<{
  method: "GET" | "POST" | "PUT" | "DELETE";
  target: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawHeaders: readonly string[];
  body: Uint8Array;
}>;

const fakeCore = (seen: { requests: VerifiedGatewayRequest[] }): GatewayCore => ({
  openGatewayAccount: async () => {
    throw new Error("not used by exposure test");
  },
  handle: async (request) => {
    seen.requests.push(request);
    return Object.freeze({
      requestId: request.context.requestId,
      correlationId: request.context.correlationId,
      protocol: "2.0" as const,
      data: Object.freeze({ accepted: true, method: request.method, target: request.target }),
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
  body: input.body.length === 0 ? undefined : Object.freeze({ accepted: true }),
});

const rawRequest = (url: string, method: "GET" | "POST" = "GET", body = ""): IncomingMessage => Object.assign(
  Readable.from(body.length === 0 ? [] : [Buffer.from(body, "utf8")]),
  {
    method,
    url,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    },
    rawHeaders: ["content-type", "application/json"],
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

const routeCases = [
  { path: "/agent-life/v2/negotiate", method: "POST" as const, body: "{}" },
  { path: "/agent-life/v2/events?cursor=cursor-1", method: "GET" as const, body: "" },
  { path: "/agent-life/v2/conversations", method: "POST" as const, body: "{}" },
  { path: "/agent-life/v2/attachments", method: "POST" as const, body: "{}" },
  { path: "/agent-life/v2/device-requests/request-1", method: "GET" as const, body: "" },
] as const;

describe("OpenClaw Agent-life exposure modes", () => {
  it("uses the same raw route cases and verified Core behavior for all three modes", async () => {
    const legacyAdapter = await import("../adapter.js");
    expect("createGatewayExposure" in legacyAdapter).toBe(true);

    const { createGatewayExposure } = await import("../src/http/routes.js");
    const modes = ["host-route", "loopback-reverse-proxy", "direct-tls"] as const;
    const modeResults: unknown[] = [];

    for (const mode of modes) {
      const seen = { requests: [] as VerifiedGatewayRequest[] };
      const exposure = createGatewayExposure(mode, {
        core: fakeCore(seen),
        hostVersion: "2026.7.1-2",
        verifyRequest: (input) => verifiedRequest(input),
      });
      const results: unknown[] = [];
      for (const routeCase of routeCases) {
        const route = exposure.routes.find((candidate) => (
          routeCase.path === candidate.path || routeCase.path.startsWith(candidate.path)
        ));
        if (route === undefined) throw new Error(`route missing: ${routeCase.path}`);
        const { response, state } = rawResponse();
        await expect(route.handler(rawRequest(routeCase.path, routeCase.method, routeCase.body), response)).resolves.toBe(true);
        results.push({
          statusCode: state.statusCode,
          body: JSON.parse(state.body),
          contentType: state.headers["content-type"],
        });
      }
      expect(seen.requests.map((request) => request.target)).toEqual(routeCases.map(({ path }) => path));
      expect(exposure.admin.remotePort).toBeNull();
      modeResults.push(results);
    }

    expect(modeResults[0]).toEqual(modeResults[1]);
    expect(modeResults[1]).toEqual(modeResults[2]);
    expect(modeResults[0]).toEqual(routeCases.map(({ path, method }) => ({
      statusCode: 200,
      body: {
        requestId: "request-a",
        correlationId: "correlation-a",
        protocol: "2.0",
        data: { accepted: true, method, target: path },
      },
      contentType: "application/json; charset=utf-8",
    })));
  });

  it("returns the same HOST_INCOMPATIBLE result for every exposure mode", async () => {
    const { createGatewayExposure } = await import("../src/http/routes.js");
    const modes = ["host-route", "loopback-reverse-proxy", "direct-tls"] as const;
    const results: unknown[] = [];
    for (const mode of modes) {
      const exposure = createGatewayExposure(mode, {
        core: fakeCore({ requests: [] }),
        hostVersion: "2026.8.0",
        verifyRequest: () => {
          throw new Error("incompatible host must not call verifier");
        },
      });
      const route = exposure.routes.find((candidate) => candidate.path === "/agent-life/v2/negotiate");
      if (route === undefined) throw new Error("negotiate route missing");
      const { response, state } = rawResponse();
      await expect(route.handler(rawRequest("/agent-life/v2/negotiate", "POST", "{}"), response)).resolves.toBe(true);
      results.push({ statusCode: state.statusCode, body: JSON.parse(state.body) });
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]).toMatchObject({ statusCode: 503, body: { error: { code: "HOST_INCOMPATIBLE" } } });
  });

  it("fails closed for missing or malformed host versions and invalid version ranges in routes and admin", async () => {
    const { createGatewayExposure } = await import("../src/http/routes.js");
    const { createAdminService } = await import("../src/admin/service.js");
    const hostVersions: Array<string | undefined> = [undefined, "not-a-version"];

    for (const hostVersion of hostVersions) {
      const exposure = createGatewayExposure("host-route", {
        core: fakeCore({ requests: [] }),
        hostVersion,
      });
      const route = exposure.routes.find((candidate) => candidate.path === "/agent-life/v2/negotiate");
      if (route === undefined) throw new Error("negotiate route missing");
      const { response, state } = rawResponse();
      await expect(route.handler(rawRequest("/agent-life/v2/negotiate", "POST", "{}"), response)).resolves.toBe(true);
      expect(state.statusCode).toBe(503);
      expect(JSON.parse(state.body)).toMatchObject({ error: { code: "HOST_INCOMPATIBLE" } });

      const admin = createAdminService({ hostVersion });
      await expect(admin.createAccount({ accountId: "account-a", localConfirmation: true })).resolves.toMatchObject({
        ok: false,
        readOnly: true,
        error: { code: "HOST_INCOMPATIBLE" },
      });
    }

    const invalidRange = {
      minVersion: "2026.8.0",
      maxVersion: "2026.7.1",
      verifiedCommit: "pinned-test-commit",
    };
    const exposure = createGatewayExposure("host-route", {
      core: fakeCore({ requests: [] }),
      hostVersion: "2026.7.1",
      hostApi: invalidRange,
    });
    const route = exposure.routes.find((candidate) => candidate.path === "/agent-life/v2/negotiate");
    if (route === undefined) throw new Error("negotiate route missing");
    const { response, state } = rawResponse();
    await expect(route.handler(rawRequest("/agent-life/v2/negotiate", "POST", "{}"), response)).resolves.toBe(true);
    expect(state.statusCode).toBe(503);
    await expect(createAdminService({ hostVersion: "2026.7.1", hostApi: invalidRange }).status()).resolves.toMatchObject({
      ok: true,
      readOnly: true,
    });

    const invalidFormat = {
      minVersion: "not-a-version",
      maxVersion: "2026.7.1",
      verifiedCommit: "pinned-test-commit",
    };
    const invalidFormatExposure = createGatewayExposure("host-route", {
      core: fakeCore({ requests: [] }),
      hostVersion: "2026.7.1",
      hostApi: invalidFormat,
    });
    const invalidFormatRoute = invalidFormatExposure.routes.find((candidate) => candidate.path === "/agent-life/v2/negotiate");
    if (invalidFormatRoute === undefined) throw new Error("negotiate route missing");
    const invalidFormatResponse = rawResponse();
    await expect(invalidFormatRoute.handler(
      rawRequest("/agent-life/v2/negotiate", "POST", "{}"),
      invalidFormatResponse.response,
    )).resolves.toBe(true);
    expect(invalidFormatResponse.state.statusCode).toBe(503);
    await expect(createAdminService({ hostVersion: "2026.7.1", hostApi: invalidFormat }).status()).resolves.toMatchObject({
      ok: true,
      readOnly: true,
    });
  });
});
