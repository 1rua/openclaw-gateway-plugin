import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { coreSchemaHash } from "../../../gateway-contract/src/core-schema-hash.js";
import { createAdminService } from "../src/admin/service.js";
import { createGatewayCore } from "../src/core/gateway-core.js";
import { DEFAULT_ATTACHMENT_POLICY } from "../src/core/attachment-policy.js";
import {
  createGatewayExposure,
  type GatewayExposure,
  type GatewayRouteServices,
} from "../src/http/routes.js";

const HOST_VERSION = "2026.7.1";
const ACCOUNT_ID = "acct_alice";
const DEVICE_PUBLIC_KEY = "A".repeat(43);

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "open-android-intelligence-openclaw-capabilities-"));

let requestSequence = 0;
/** Every call needs its own request id: the ledger binds one id to one input. */
const nextRequestId = (): string => `req_${(requestSequence += 1)}`;

const rawRequest = (
  url: string,
  body = "{}",
  method: "GET" | "POST" | "PUT" | "DELETE" = "POST",
  requestId = nextRequestId(),
): IncomingMessage => Object.assign(
  Readable.from(body.length === 0 ? [] : [Buffer.from(body, "utf8")]),
  {
    method,
    url,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      authorization: "Bearer redacted-test-token",
      "x-open-android-intelligence-request-id": requestId,
      ...(method === "POST" || method === "PUT" || method === "DELETE"
        ? { "idempotency-key": requestId }
        : {}),
    },
    rawHeaders: ["content-type", "application/json"],
  },
) as unknown as IncomingMessage;

const rawResponse = (): {
  response: ServerResponse;
  state: { statusCode: number; headers: Record<string, string>; body: string };
} => {
  const state = { statusCode: 0, headers: {} as Record<string, string>, body: "" };
  const response = {
    statusCode: state.statusCode,
    setHeader: (name: string, value: string): void => { state.headers[name.toLowerCase()] = value; },
    end: (body?: string): void => { state.body = body ?? ""; },
  } as unknown as ServerResponse;
  Object.defineProperty(response, "statusCode", {
    get: () => state.statusCode,
    set: (value: number) => { state.statusCode = value; },
  });
  return { response, state };
};

const call = async (
  exposure: GatewayExposure,
  path: string,
  body: unknown,
  method: "GET" | "POST" | "PUT" | "DELETE" = "POST",
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const route = exposure.routes.find((candidate) => candidate.path === path || path.startsWith(candidate.path));
  if (route === undefined) throw new Error(`route missing: ${path}`);
  const { response, state } = rawResponse();
  await route.handler(rawRequest(path, typeof body === "string" ? body : JSON.stringify(body), method), response);
  return { statusCode: state.statusCode, body: JSON.parse(state.body) as Record<string, unknown> };
};

const authenticatedVerifier = (input: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  target: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
}) => {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const idempotencyKey = single(input.headers["idempotency-key"]);
  const requestId = single(input.headers["x-open-android-intelligence-request-id"]) ?? "req_1";
  return Object.freeze({
    context: Object.freeze({
      accountId: ACCOUNT_ID,
      deviceId: "dev_1",
      sessionId: "sess_1",
      requestId,
      correlationId: "cor_1",
      pairingGeneration: 1,
      grantRevision: 1,
    }),
    method: input.method,
    target: input.target,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(input.body.byteLength === 0
      ? {}
      : { body: JSON.parse(Buffer.from(input.body).toString("utf8")) as unknown }),
  });
};

const exposureFor = (services: Partial<GatewayRouteServices> & { core: GatewayRouteServices["core"] }): GatewayExposure =>
  createGatewayExposure("host-route", {
    hostVersion: HOST_VERSION,
    verifyRequest: authenticatedVerifier,
    ...services,
  });

const negotiationBody = (overrides: Record<string, unknown> = {}) => ({
  negotiationId: "neg_1",
  protocol: { major: 2, minor: 0 },
  client: {
    installationId: "install_1",
    appVersion: "2.0.0",
    platform: "android",
    platformApi: 35,
  },
  features: {
    auth: ["password", "refresh", "account-invitation", "device-key"],
    messages: ["chat-v1"],
    attachments: ["staged-sha256-v1"],
    events: ["sse-cursor-v1"],
    deviceRequests: ["risk-queue-v1"],
    conversationUi: ["agent-command-catalog-v1", "message-batches-v1"],
  },
  schemaHashes: { core: coreSchemaHash() },
  ...overrides,
});

describe("OpenClaw Gateway capabilities", () => {
  it("negotiates with the real schema digest and advertises only implemented capabilities", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const exposure = exposureFor({ core });

    const rejected = await call(exposure, "/open-android-intelligence/v2/negotiate", negotiationBody({
      schemaHashes: { core: `sha256:${"b".repeat(64)}` },
    }));
    expect(rejected.statusCode).toBe(406);
    expect(rejected.body["error"]).toMatchObject({ code: "PROTOCOL_INCOMPATIBLE" });

    const accepted = await call(exposure, "/open-android-intelligence/v2/negotiate", negotiationBody());
    expect(accepted.statusCode).toBe(200);
    const data = accepted.body["data"] as Record<string, unknown>;
    expect(data["protocol"]).toEqual({ major: 2, minor: 0 });
    const features = data["features"] as Record<string, unknown>;
    // account-invitation and device-key are offered by the client but not
    // implemented here, so they must not come back as agreed.
    expect(features["auth"]).toEqual(["password", "refresh"]);
    expect(features["messages"]).toBe("chat-v1");
    expect(JSON.stringify(features)).not.toContain("message-batches-v1");
    expect(features["conversationUi"]).toEqual(["agent-command-catalog-v1"]);
    expect(data["limits"]).toMatchObject({
      maxSingleAttachmentBytes: DEFAULT_ATTACHMENT_POLICY.maxSingleAttachmentBytes,
      maxMessageAttachmentBytes: DEFAULT_ATTACHMENT_POLICY.maxMessageAttachmentBytes,
      attachmentTtlSeconds: DEFAULT_ATTACHMENT_POLICY.attachmentTtlSeconds,
    });
  });

  it("logs in only an account with a recorded digest, and only after a negotiation", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const admin = createAdminService({ core, hostVersion: HOST_VERSION });
    const exposure = exposureFor({ core });

    await expect(admin.createAccount({ accountId: ACCOUNT_ID, localConfirmation: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "PASSWORD_REQUIRED" },
    });
    await expect(admin.createAccount({
      accountId: ACCOUNT_ID, password: "s3cret", localConfirmation: true,
    })).resolves.toMatchObject({ ok: true });
    expect(core.accountExists(ACCOUNT_ID)).toBe(true);

    const loginBody = (negotiationId: string, password: string) => ({
      negotiationId,
      username: ACCOUNT_ID,
      password,
      installation: {
        installationId: "install_1",
        displayName: "Alice phone",
        devicePublicKey: DEVICE_PUBLIC_KEY,
      },
    });

    // Login must reference a negotiation this Gateway issued.
    const unbound = await call(exposure, "/open-android-intelligence/v2/sessions/password", loginBody("neg_unknown", "s3cret"));
    expect(unbound.statusCode).toBe(406);

    await call(exposure, "/open-android-intelligence/v2/negotiate", negotiationBody({ negotiationId: "neg_login" }));

    const wrongPassword = await call(exposure, "/open-android-intelligence/v2/sessions/password", loginBody("neg_login", "wrong"));
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.body["error"]).toMatchObject({ code: "AUTHENTICATION_FAILED" });

    const login = await call(exposure, "/open-android-intelligence/v2/sessions/password", loginBody("neg_login", "s3cret"));
    expect(login.statusCode).toBe(200);
    const session = login.body["data"] as Record<string, unknown>;
    expect(typeof session["accessToken"]).toBe("string");
    expect(typeof session["refreshCredential"]).toBe("string");

    // The facts a host verifier needs come from the session the login issued.
    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      const facts = account.sessions.resolveSession(
        String(session["accessToken"]),
        String(session["sessionId"]),
        String(session["deviceId"]),
      );
      expect(facts).toMatchObject({ devicePublicKey: DEVICE_PUBLIC_KEY, pairingGeneration: 1, grantRevision: 1 });
      expect(account.sessions.resolveSession(String(session["accessToken"]), String(session["sessionId"]), "dev_other")).toBeUndefined();
    } finally {
      account.close();
    }
  });

  it("enforces the negotiated attachment policy on the wire", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const exposure = exposureFor({ core });

    const createBody = (overrides: Record<string, unknown> = {}) => ({
      clientAttachmentId: "att_client_1",
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      ...overrides,
    });

    const tooLarge = await call(exposure, "/open-android-intelligence/v2/attachments", createBody({
      sizeBytes: DEFAULT_ATTACHMENT_POLICY.maxSingleAttachmentBytes + 1,
    }));
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.body["error"]).toMatchObject({ code: "ATTACHMENT_LIMIT_EXCEEDED" });

    const unsupportedType = await call(exposure, "/open-android-intelligence/v2/attachments", createBody({
      mediaType: "application/zip",
    }));
    expect(unsupportedType.statusCode).toBe(400);
    expect(unsupportedType.body["error"]).toMatchObject({ code: "ATTACHMENT_LIMIT_EXCEEDED" });

    const accepted = await call(exposure, "/open-android-intelligence/v2/attachments", createBody());
    expect(accepted.statusCode).toBe(200);
    expect((accepted.body["data"] as Record<string, unknown>)["attachment"]).toMatchObject({ state: "created" });
  });

  it("rejects identity overrides by structure, not by text content", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const exposure = exposureFor({ core });

    const override = await call(exposure, "/open-android-intelligence/v2/conversations", {
      clientConversationId: "cconv_1",
      title: "hello",
      device_id: "attacker-device",
    });
    expect(override.body["error"]).toMatchObject({ code: "IDENTITY_OVERRIDE_REJECTED" });

    const conversation = await call(exposure, "/open-android-intelligence/v2/conversations", {
      clientConversationId: "cconv_1",
      title: "hello",
    });
    expect(conversation.statusCode).toBe(200);
    const conversationId = ((conversation.body["data"] as Record<string, unknown>)["conversation"] as Record<string, unknown>)["conversationId"];

    // A user message whose *text* merely mentions an identity field is a
    // message, not an identity override.
    const message = await call(exposure, `/open-android-intelligence/v2/conversations/${String(conversationId)}/messages`, {
      clientMessageId: "cm_1",
      text: 'the payload said {"deviceId": "someone-else"} and I pasted it',
      attachments: [],
    });
    expect(message.statusCode).toBe(200);
    expect((message.body["data"] as Record<string, unknown>)["message"]).toMatchObject({ status: "accepted" });
  });

  it("declares capabilities and security boundaries honestly", async () => {
    const manifest = (await import("../adapter.js")).OPENCLAW_PLUGIN_MANIFEST;

    expect(manifest.capabilitySchemaHash).toBe(coreSchemaHash());
    // No control may be claimed that the implementation does not enforce.
    expect(manifest.capabilities.encryptionAtRest).toBe(false);
    expect(manifest.securityBoundary.encryptionAtRest).toBe("not-implemented");
    expect(manifest.securityBoundary.zeroRetention).toBe("not-implemented");
    expect(manifest.capabilities.sse).toBe(false);
    expect(manifest.securityBoundary.ed25519).toBe("host-supplied-verifier");
    expect("zeroRetention" in manifest).toBe(false);

    // Every capability claimed as available must have a registered route.
    const exposure = exposureFor({ core: createGatewayCore({ storageRoot: tempRoot() }) });
    const paths = new Set(exposure.routes.map((route) => route.path));
    const claimedRoutes: Array<[boolean, string]> = [
      [manifest.capabilities.negotiation, "/open-android-intelligence/v2/negotiate"],
      [manifest.capabilities.passwordLogin, "/open-android-intelligence/v2/sessions/password"],
      [manifest.capabilities.refreshRotation, "/open-android-intelligence/v2/sessions/refresh"],
      [manifest.capabilities.sessionLogout, "/open-android-intelligence/v2/sessions/current"],
      [manifest.capabilities.commandCatalog, "/open-android-intelligence/v2/commands"],
      [manifest.capabilities.conversationRead, "/open-android-intelligence/v2/conversations"],
      [manifest.capabilities.attachmentPolicy, "/open-android-intelligence/v2/attachments"],
    ];
    for (const [claimed, path] of claimedRoutes) {
      if (claimed) expect(paths.has(path), `claimed capability without a route: ${path}`).toBe(true);
    }
  });
});
