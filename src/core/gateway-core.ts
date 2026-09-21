import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import canonicalize from "canonicalize";

import { coreSchemaHash } from "../../../../gateway-contract/src/core-schema-hash.js";
import { validateGatewayValue, type GatewaySchemaName } from "../../../../gateway-contract/src/schema-registry.js";
import { accountPaths, defaultOpenClawGatewayRoot, type AccountPaths } from "./account-paths.js";
import { openAccountStore, type GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";
import { AttachmentStore } from "./attachment-store.js";
import { DEFAULT_ATTACHMENT_POLICY, type AttachmentPolicy } from "./attachment-policy.js";
import { ConversationPort } from "./conversation-port.js";
import { CredentialStore } from "./credential-store.js";
import { DeviceRequestStore } from "./device-request-store.js";
import { EventStore } from "./event-store.js";
import { SessionService } from "./session-service.js";
import {
  runSharedVectors,
  type ConformanceResult,
  type ConformanceVectorOperation,
} from "./shared-vectors.js";

export type GatewayAccount = Readonly<{
  accountId: string;
  masterKeyRef: string;
  paths: AccountPaths;
  store: GatewayAccountStore;
  audit: AuditStore;
  attachments: AttachmentStore;
  conversations: ConversationPort;
  deviceRequests: DeviceRequestStore;
  events: EventStore;
  sessions: SessionService;
  credentials: CredentialStore;
  close: () => void;
}>;

export type GatewayCoreOptions = Readonly<{
  storageRoot?: string;
  attachmentPolicy?: AttachmentPolicy;
}>;

export type VerifiedRequestContext = Readonly<{
  accountId: string;
  deviceId: string;
  sessionId: string;
  requestId: string;
  correlationId: string;
  pairingGeneration: number;
  grantRevision: number;
}>;

/**
 * A request the host has already authenticated.
 *
 * `context` is absent for the endpoints contract §4/§5 run before
 * authentication (`/negotiate`, `/sessions/*`); those requests carry no
 * verified identity and must never be treated as if they had one.
 */
export type VerifiedGatewayRequest = Readonly<{
  context?: VerifiedRequestContext;
  method: "GET" | "POST" | "PUT" | "DELETE";
  target: string;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
  lastEventId?: string;
  now?: Date;
}>;

export type GatewayResponse = Readonly<{
  requestId: string;
  correlationId: string;
  protocol: "2.0";
  data?: Readonly<Record<string, unknown>>;
  error?: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSeconds: number | null;
    details: Readonly<Record<string, unknown>>;
  }>;
}>;

export type GatewayCore = Readonly<{
  openGatewayAccount: (accountId: string) => Promise<GatewayAccount>;
  /** Whether this host registered the account; login never creates one. */
  accountExists: (accountId: string) => boolean;
  /** Resource-level removal of one logical Gateway (contract §13). */
  deleteGatewayAccount: (accountId: string) => boolean;
  handle: (request: VerifiedGatewayRequest) => Promise<GatewayResponse>;
  runSharedVectors: (contractRoot?: string) => ConformanceResult[];
}>;

export type { ConformanceResult, ConformanceVectorOperation };

export const GATEWAY_PROTOCOL_VERSION = Object.freeze({ major: 2, minor: 0 });

/**
 * Only capabilities this implementation actually serves are ever advertised.
 * Contract §4 keeps the base session capabilities in `messages`/`attachments`
 * and the conversation-surface ladder in `conversationUi`.
 */
export const SUPPORTED_AUTH = Object.freeze(["password", "refresh"]);
// `agent-command-new-v1` (contract §7.1) is deliberately absent: this host has
// no `/new` command entry that would atomically create a conversation and answer
// with the authoritative id, so agreeing to it would promise the phone a service
// that does not exist. The phone reads the absence and tells the user instead of
// building a conversation only it knows about.
// `agent-approval-cards-v1` (contract §7.2) is deliberately absent for the same
// reason: this host has no live SSE/WebSocket channel, so it could never push an
// approval card to the phone nor receive its decision in time. Agreeing to it
// would paint a card whose buttons can do nothing.
export const SUPPORTED_CONVERSATION_UI = Object.freeze(["agent-command-catalog-v1"]);
export const REQUIRED_FEATURES = Object.freeze({
  messages: "chat-v1",
  attachments: "staged-sha256-v1",
  events: "sse-cursor-v1",
  deviceRequests: "risk-queue-v1",
});

const identityOf = (request: VerifiedGatewayRequest): { requestId: string; correlationId: string } => {
  if (request.context !== undefined) {
    return { requestId: request.context.requestId, correlationId: request.context.correlationId };
  }
  // Pre-auth responses echo the negotiation the client named, so a client can
  // still correlate a rejected negotiation with the request it sent.
  const body = request.body;
  const negotiationId = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)["negotiationId"]
    : undefined;
  const fallback = typeof negotiationId === "string" && negotiationId.length > 0
    ? negotiationId
    : "open-android-intelligence-route";
  const headerRequestId = request.headers?.["x-open-android-intelligence-request-id"];
  const requestId = typeof headerRequestId === "string" && headerRequestId.length > 0
    ? headerRequestId
    : fallback;
  return { requestId, correlationId: requestId };
};

const success = (
  request: VerifiedGatewayRequest,
  data: Readonly<Record<string, unknown>>,
): GatewayResponse => {
  const identity = identityOf(request);
  return Object.freeze({
    requestId: identity.requestId,
    correlationId: identity.correlationId,
    protocol: "2.0" as const,
    data,
  });
};

const failure = (
  request: VerifiedGatewayRequest,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayResponse => {
  const identity = identityOf(request);
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

/**
 * JCS, not `JSON.stringify`: the idempotency input hash must not depend on the
 * key order a caller happened to use, and it must match the other hosts.
 */
const canonicalJson = (value: unknown): string => {
  if (value instanceof Uint8Array) {
    return JSON.stringify({ bytesSha256: createHash("sha256").update(value).digest("hex") });
  }
  return canonicalize(value ?? null) ?? "null";
};

const assertSchema = (schemaName: GatewaySchemaName, value: unknown): void => {
  const result = validateGatewayValue(schemaName, value);
  if (!result.ok) throw new Error("SCHEMA_INVALID");
};

const bodyRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("SCHEMA_INVALID");
  return value as Readonly<Record<string, unknown>>;
};

/**
 * Wire codes that are reported to the client as-is.
 *
 * Anything else is an internal failure and must not leak as a plausible
 * protocol error.
 */
const protocolErrorCodes = new Set([
  "SCHEMA_INVALID",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "PROTOCOL_INCOMPATIBLE",
  "REFRESH_REUSED",
  "IDENTITY_OVERRIDE_REJECTED",
  "PAIRING_GENERATION_STALE",
  "GRANT_STALE",
  "IDEMPOTENCY_CONFLICT",
  "OUTCOME_UNKNOWN",
  "ATTACHMENT_LIMIT_EXCEEDED",
  "ATTACHMENT_DIGEST_MISMATCH",
  "ATTACHMENT_EXPIRED",
  "CURSOR_CONFLICT",
  "CURSOR_EXPIRED",
]);

/** The subset an idempotent write may record as its durable outcome. */
const persistableErrorCodes = new Set([
  "SCHEMA_INVALID",
  "IDENTITY_OVERRIDE_REJECTED",
  "PAIRING_GENERATION_STALE",
  "GRANT_STALE",
  "IDEMPOTENCY_CONFLICT",
  "OUTCOME_UNKNOWN",
  "ATTACHMENT_LIMIT_EXCEEDED",
  "ATTACHMENT_DIGEST_MISMATCH",
  "ATTACHMENT_EXPIRED",
  "CURSOR_CONFLICT",
  "CURSOR_EXPIRED",
]);

const gatewayErrorCode = (error: unknown): string => {
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  return protocolErrorCodes.has(code) ? code : "INTERNAL_ERROR";
};

const persistableProtocolError = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !persistableErrorCodes.has(error.message)) return undefined;
  return error.message;
};

/**
 * Rejects a body that tries to set identity the authenticated context owns.
 *
 * The check is structural: scanning a serialized body with a pattern both misses
 * snake_case spellings and rejects a user message whose text merely contains
 * `"deviceId":`, so it looks at keys of nested objects and arrays instead.
 */
const FORBIDDEN_IDENTITY_KEYS = new Set([
  "accountid",
  "deviceid",
  "principalid",
  "pairinggeneration",
]);

const assertNoIdentityOverride = (value: unknown, depth = 0): void => {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoIdentityOverride(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_IDENTITY_KEYS.has(normalized)) throw new Error("IDENTITY_OVERRIDE_REJECTED");
    assertNoIdentityOverride(child, depth + 1);
  }
};

const cursorExpiredDetails = Object.freeze({
  recoverableResources: Object.freeze(["conversations", "attachments", "device-requests"] as const),
});

const runIdempotent = (
  account: GatewayAccount,
  request: VerifiedGatewayRequest,
  work: () => GatewayResponse,
  validateReplay?: () => string | undefined,
): GatewayResponse => {
  if (request.method === "GET") return work();
  if (request.idempotencyKey !== request.context?.requestId) return failure(request, "IDEMPOTENCY_CONFLICT");
  const now = request.now ?? new Date();
  const inputHash = createHash("sha256")
    .update(canonicalJson({ method: request.method, target: request.target, body: request.body }), "utf8")
    .digest("hex");
  return account.store.transaction(() => {
    const existing = account.store.database
      .prepare("SELECT input_hash, outcome_json, expires_at FROM idempotency_ledger WHERE device_id = ? AND request_id = ?")
      .get(request.context!.deviceId, request.context!.requestId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (String(existing.input_hash) !== inputHash) return failure(request, "IDEMPOTENCY_CONFLICT");
      if (Date.parse(String(existing.expires_at)) <= now.getTime()) {
        return failure(request, "OUTCOME_UNKNOWN");
      }
      const replayError = validateReplay?.();
      if (replayError !== undefined) return failure(request, replayError);
      return JSON.parse(String(existing.outcome_json)) as GatewayResponse;
    }

    let response: GatewayResponse;
    try {
      response = work();
    } catch (error) {
      const code = persistableProtocolError(error);
      if (code === undefined) throw error;
      response = failure(request, code);
    }
    account.store.database
      .prepare(`
        INSERT INTO idempotency_ledger(device_id, request_id, input_hash, outcome_json, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        request.context!.deviceId,
        request.context!.requestId,
        inputHash,
        JSON.stringify(response),
        new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      );
    return response;
  });
};

const buildAccount = (
  root: string,
  accountId: string,
  policy: AttachmentPolicy,
): GatewayAccount => {
  const paths = accountPaths(root, accountId);
  const store = openAccountStore(paths);
  const audit = new AuditStore(store);
  const events = new EventStore(store, policy.eventRetentionSeconds);
  const attachments = new AttachmentStore(accountId, paths, store, audit, policy);
  const credentials = new CredentialStore(store);
  const masterKeyRef = (store.database
    .prepare("SELECT value FROM account_metadata WHERE key = 'master_key_ref'")
    .get() as { value: string }).value;
  return Object.freeze({
    accountId,
    masterKeyRef,
    paths,
    store,
    audit,
    attachments,
    conversations: new ConversationPort(accountId, store, attachments, audit, policy),
    deviceRequests: new DeviceRequestStore(accountId, store, audit, events),
    events,
    sessions: new SessionService(accountId, store, audit, credentials),
    credentials,
    close: store.close,
  });
};

const deploymentIdOf = (root: string): string =>
  `deploy_${createHash("sha256").update(root, "utf8").digest("hex").slice(0, 16)}`;

export const createGatewayCore = (options: GatewayCoreOptions = {}): GatewayCore => {
  const configuredRoot = options.storageRoot;
  /**
   * Resolved on first use.
   *
   * Operating without storage (shared vectors, an account-less negotiation)
   * does not require a data directory, while every storage-backed call fails
   * loudly instead of inventing one from the shell's current directory.
   */
  const resolveRoot = (): string => configuredRoot ?? defaultOpenClawGatewayRoot();
  const policy = options.attachmentPolicy ?? DEFAULT_ATTACHMENT_POLICY;
  // Pending negotiations are short-lived and this host has no durable cross-
  // account store for them; a restart simply requires a new negotiation.
  const pendingNegotiations = new Map<string, { installationId: string; expiresAt: number; inputHash: string }>();

  const negotiationResponse = (
    body: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> => {
    assertSchema("negotiate.request", body);
    const schemaHashes = bodyRecord(body["schemaHashes"]);
    if (String(schemaHashes["core"]) !== coreSchemaHash()) {
      throw new Error("PROTOCOL_INCOMPATIBLE");
    }
    const requested = bodyRecord(body["features"]);
    const auth = (requested["auth"] as readonly unknown[]).filter(
      (item): item is string => typeof item === "string" && SUPPORTED_AUTH.includes(item),
    );
    for (const required of Object.values(REQUIRED_FEATURES)) {
      const offered = Object.values(requested).flat().filter((item): item is string => typeof item === "string");
      if (!offered.includes(required)) throw new Error("PROTOCOL_INCOMPATIBLE");
    }
    const conversationUi = Array.isArray(requested["conversationUi"])
      ? (requested["conversationUi"] as readonly unknown[]).filter(
          (item): item is string => typeof item === "string" && SUPPORTED_CONVERSATION_UI.includes(item),
        )
      : [];
    const features: Record<string, unknown> = { auth, ...REQUIRED_FEATURES };
    if (conversationUi.length > 0) features["conversationUi"] = conversationUi;
    return Object.freeze({
      protocol: { ...GATEWAY_PROTOCOL_VERSION },
      features,
      limits: {
        maxSingleAttachmentBytes: policy.maxSingleAttachmentBytes,
        maxMessageAttachmentBytes: policy.maxMessageAttachmentBytes,
        allowedMediaTypes: [...policy.allowedMediaTypes],
        attachmentTtlSeconds: policy.attachmentTtlSeconds,
        eventRetentionSeconds: policy.eventRetentionSeconds,
        maxClockSkewSeconds: policy.maxClockSkewSeconds,
      },
      gatewayIdentity: {
        deploymentId: deploymentIdOf(resolveRoot()),
        // No certificate pin is configured on this host yet; the phone treats an
        // all-zero pin as "no additional pin", the same value the Hermes host
        // reports before an account records its own.
        tlsSpkiSha256: `sha256:${"0".repeat(64)}`,
      },
    });
  };

  const handlePreAuth = async (request: VerifiedGatewayRequest): Promise<GatewayResponse> => {
    const now = request.now ?? new Date();
    if (request.method === "GET" && request.target.startsWith("/open-android-intelligence/v2/events")) {
      return failure(request, "AUTHENTICATION_REQUIRED");
    }
    if (request.method === "POST" && request.target === "/open-android-intelligence/v2/negotiate") {
      try {
        const body = bodyRecord(request.body);
        const response = negotiationResponse(body);
        assertSchema("negotiate.response", response);
        const negotiationId = String(bodyRecord(body)["negotiationId"]);
        const inputHash = createHash("sha256")
          .update(canonicalJson({ method: request.method, target: request.target, body }), "utf8")
          .digest("hex");
        const existing = pendingNegotiations.get(negotiationId);
        if (existing !== undefined && existing.inputHash !== inputHash) {
          throw new Error("PROTOCOL_INCOMPATIBLE");
        }
        const installationId = String(bodyRecord(body["client"])["installationId"]);
        pendingNegotiations.set(negotiationId, {
          installationId,
          expiresAt: now.getTime() + 5 * 60 * 1000,
          inputHash,
        });
        return success(request, response as Readonly<Record<string, unknown>>);
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      }
    }
    if (request.method === "POST" && request.target === "/open-android-intelligence/v2/sessions/password") {
      try {
        const body = bodyRecord(request.body);
        assertSchema("session.password", body);
        // Login must never be the act that creates an account.
        const accountId = String(body["username"]);
        if (!accountExistsIn(resolveRoot(), accountId)) return failure(request, "AUTHENTICATION_FAILED");
        const negotiationId = String(body["negotiationId"]);
        const pending = pendingNegotiations.get(negotiationId);
        const installation = bodyRecord(body["installation"]);
        const installationId = String(installation["installationId"]);
        if (
          pending === undefined
          || pending.expiresAt <= now.getTime()
          || pending.installationId !== installationId
        ) {
          return failure(request, "PROTOCOL_INCOMPATIBLE");
        }
        const account = buildAccount(resolveRoot(), accountId, policy);
        try {
          const bundle = account.sessions.createPasswordSession({
            username: accountId,
            password: String(body["password"]),
            installation: {
              installationId,
              displayName: String(installation["displayName"] ?? ""),
              devicePublicKey: String(installation["devicePublicKey"]),
            },
            correlationId: identityOf(request).correlationId,
            now,
          });
          return success(request, { ...bundle, accountId });
        } finally {
          account.close();
        }
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      }
    }
    if (request.method === "POST" && request.target === "/open-android-intelligence/v2/sessions/refresh") {
      try {
        const body = bodyRecord(request.body);
        assertSchema("session.refresh", body);
        const accountId = String(body["accountId"]);
        if (!accountExistsIn(resolveRoot(), accountId)) return failure(request, "AUTHENTICATION_FAILED");
        const account = buildAccount(resolveRoot(), accountId, policy);
        try {
          const bundle = account.sessions.refresh({
            refreshCredential: String(body["refreshCredential"]),
            installationId: String(body["installationId"]),
            deviceId: String(body["deviceId"]),
            correlationId: identityOf(request).correlationId,
            now,
          });
          return success(request, { ...bundle, accountId });
        } finally {
          account.close();
        }
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      }
    }
    if (
      request.method === "DELETE"
      && request.target.split("?")[0] === "/open-android-intelligence/v2/sessions/current"
    ) {
      try {
        const headers = request.headers ?? {};
        const accountId = headers["x-open-android-intelligence-account"];
        const deviceId = headers["x-open-android-intelligence-device"];
        const sessionId = headers["x-open-android-intelligence-session"];
        const authorization = headers["authorization"];
        const accessToken = typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")
          ? authorization.slice(7).trim()
          : "";
        if (!accountId || !deviceId || !sessionId || accessToken.length === 0) {
          return failure(request, "AUTHENTICATION_REQUIRED");
        }
        if (!accountExistsIn(resolveRoot(), accountId)) return failure(request, "AUTHENTICATION_FAILED");
        const revokeRefresh = /(?:^|[?&])revokeRefresh=true(?:&|$)/.test(request.target);
        const account = buildAccount(resolveRoot(), accountId, policy);
        try {
          if (!account.sessions.verifyAccessToken(accessToken, sessionId, deviceId, now)) {
            return failure(request, "AUTHENTICATION_FAILED");
          }
          account.sessions.revokeSession(sessionId, identityOf(request).correlationId, now);
          if (revokeRefresh) {
            account.sessions.revokeRefreshCredentials(deviceId, identityOf(request).correlationId, now);
          }
          return success(request, { sessionId, refreshRevoked: revokeRefresh });
        } finally {
          account.close();
        }
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      }
    }
    return failure(request, "AUTHENTICATION_REQUIRED");
  };

  const accountExistsIn = (storageRoot: string, accountId: string): boolean => {
    try {
      return existsSync(accountPaths(storageRoot, accountId).database);
    } catch (error) {
      // An unusable account id is an authentication failure, but a host without
      // a storage root is an operator error: reporting it as "no such account"
      // would look like a wrong password forever.
      if (error instanceof Error && error.message === "STORAGE_ROOT_REQUIRED") throw error;
      return false;
    }
  };

  return Object.freeze({
    openGatewayAccount: async (accountId: string): Promise<GatewayAccount> =>
      buildAccount(resolveRoot(), accountId, policy),
    accountExists: (accountId: string): boolean => accountExistsIn(resolveRoot(), accountId),
    deleteGatewayAccount: (accountId: string): boolean => {
      // The account directory *is* the logical Gateway: database, staged and
      // confirmed attachment bytes, credentials and the account audit trail.
      const paths = accountPaths(resolveRoot(), accountId);
      if (!existsSync(paths.root)) return false;
      rmSync(paths.root, { recursive: true, force: true });
      return true;
    },
    handle: async (request: VerifiedGatewayRequest): Promise<GatewayResponse> => {
      try {
        if (request.context === undefined) return await handlePreAuth(request);
        const account = buildAccount(resolveRoot(), request.context.accountId, policy);
        try {
          assertNoIdentityOverride(request.body);
          if (request.method === "GET" && request.target.startsWith("/open-android-intelligence/v2/events")) {
            const cursor = new URL(`https://gateway.local${request.target}`).searchParams.get("cursor");
            if (request.lastEventId !== undefined && request.lastEventId !== cursor) {
              return failure(request, "CURSOR_CONFLICT");
            }
            try {
              const events = account.events.readAfter(cursor, request.now);
              return success(request, { events });
            } catch (error) {
              if (gatewayErrorCode(error) === "CURSOR_EXPIRED") {
                return failure(request, "CURSOR_EXPIRED", cursorExpiredDetails);
              }
              throw error;
            }
          }
          const claimMatch = request.method === "POST"
            ? request.target.match(/^\/open-android-intelligence\/v2\/device-requests\/([^/]+)\/claim$/)
            : undefined;
          const resultMatch = request.method === "POST"
            ? request.target.match(/^\/open-android-intelligence\/v2\/device-requests\/([^/]+)\/result$/)
            : undefined;
          const validateReplay = claimMatch?.[1]
            ? () => account.deviceRequests.validateClaimReplay({
                requestId: claimMatch[1]!,
                deviceId: request.context!.deviceId,
                pairingGeneration: request.context!.pairingGeneration,
                grantRevision: request.context!.grantRevision,
                now: request.now,
              })
            : resultMatch?.[1]
              ? () => {
                  const body = bodyRecord(request.body);
                  return account.deviceRequests.validateResultReplay({
                    requestId: resultMatch[1]!,
                    deviceId: request.context!.deviceId,
                    pairingGeneration: request.context!.pairingGeneration,
                    grantRevision: request.context!.grantRevision,
                    claimId: String(body.claimId),
                    now: request.now,
                  });
                }
              : undefined;
          return runIdempotent(account, request, () => {
            if (request.method === "GET" && request.target.split("?")[0] === "/open-android-intelligence/v2/commands") {
              const languageCode = new URL(`https://gateway.local${request.target}`)
                .searchParams.get("languageCode") ?? "en";
              return success(request, commandCatalog(languageCode));
            }
            if (request.method === "GET" && request.target === "/open-android-intelligence/v2/conversations") {
              return success(request, { conversations: account.conversations.list() });
            }
            const conversationGet = request.method === "GET"
              ? request.target.split("?")[0]!.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)$/)
              : undefined;
            if (conversationGet?.[1] !== undefined) {
              return success(request, { conversation: account.conversations.get(conversationGet[1]) });
            }
            // Conversation rename (contract section 7). The body is the closed
            // `{"title": string}` shape the phone sends and the Hermes host
            // accepts; a missing or non-object body is a schema failure, never an
            // empty rename.
            const conversationPatch = request.method === "PATCH"
              ? request.target.split("?")[0]!.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)$/)
              : undefined;
            if (conversationPatch?.[1] !== undefined) {
              const body = bodyRecord(request.body);
              const title = typeof body["title"] === "string" ? body["title"] : "";
              const conversationId = conversationPatch[1]!;
              const updated = account.conversations.updateTitle({
                conversationId,
                title,
                correlationId: request.context!.correlationId,
                now: request.now,
              });
              account.events.append({
                eventType: "conversation.title.updated",
                correlationId: request.context!.correlationId,
                payload: { conversationId, title, newTitle: title },
                now: request.now,
              });
              return success(request, { conversation: updated });
            }
            if (request.method === "POST" && request.target === "/open-android-intelligence/v2/conversations") {
              assertSchema("conversation.create", request.body);
              const body = bodyRecord(request.body);
              return success(request, {
                conversation: account.conversations.create({
                  clientConversationId: String(body.clientConversationId),
                  title: typeof body.title === "string" ? body.title : undefined,
                  correlationId: request.context!.correlationId,
                }),
              });
            }
            const messageMatch = request.target.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)\/messages$/);
            if (request.method === "POST" && messageMatch?.[1] !== undefined) {
              assertSchema("message.create", request.body);
              const body = bodyRecord(request.body);
              return success(request, {
                message: account.conversations.acceptMessage({
                  conversationId: messageMatch[1],
                  clientMessageId: String(body.clientMessageId),
                  text: String(body.text),
                  attachmentIds: Array.isArray(body.attachments)
                    ? body.attachments.map((item) => String((item as Record<string, unknown>).attachmentId))
                    : [],
                  deviceId: request.context!.deviceId,
                  requestId: request.context!.requestId,
                  correlationId: request.context!.correlationId,
                }),
              });
            }
            if (request.method === "POST" && request.target === "/open-android-intelligence/v2/attachments") {
              assertSchema("attachment.create", request.body);
              const body = bodyRecord(request.body);
              return success(request, {
                attachment: account.attachments.create({
                  clientAttachmentId: String(body.clientAttachmentId),
                  filename: String(body.filename),
                  mediaType: String(body.mediaType),
                  sizeBytes: Number(body.sizeBytes),
                  sha256: String(body.sha256),
                  correlationId: request.context!.correlationId,
                }),
              });
            }
            const attachmentContentMatch = request.target.match(/^\/open-android-intelligence\/v2\/attachments\/([^/]+)\/content$/);
            if (request.method === "PUT" && attachmentContentMatch?.[1] !== undefined) {
              if (!(request.body instanceof Uint8Array)) throw new Error("SCHEMA_INVALID");
              return success(request, {
                attachment: account.attachments.uploadContent(attachmentContentMatch[1], request.body),
              });
            }
            const attachmentCommitMatch = request.target.match(/^\/open-android-intelligence\/v2\/attachments\/([^/]+)\/commit$/);
            if (request.method === "POST" && attachmentCommitMatch?.[1] !== undefined) {
              return success(request, {
                attachment: account.attachments.commit(attachmentCommitMatch[1]),
              });
            }
            if (request.method === "POST" && claimMatch?.[1] !== undefined) {
              return success(request, {
                receipt: account.deviceRequests.claim({
                  requestId: claimMatch[1],
                  deviceId: request.context!.deviceId,
                  pairingGeneration: request.context!.pairingGeneration,
                  grantRevision: request.context!.grantRevision,
                  correlationId: request.context!.correlationId,
                  now: request.now,
                }),
              });
            }
            if (request.method === "POST" && resultMatch?.[1] !== undefined) {
              const body = bodyRecord(request.body);
              if (Number(body.grantRevision) !== request.context!.grantRevision) {
                throw new Error("GRANT_STALE");
              }
              return success(request, {
                deviceRequest: account.deviceRequests.submitResult({
                  requestId: resultMatch[1],
                  deviceId: request.context!.deviceId,
                  pairingGeneration: request.context!.pairingGeneration,
                  grantRevision: request.context!.grantRevision,
                  claimId: String(body.claimId),
                  result: body.result as { outcome: "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown" },
                  correlationId: request.context!.correlationId,
                  now: request.now,
                }),
              });
            }
            return failure(request, "SCHEMA_INVALID");
          }, validateReplay);
        } finally {
          account.close();
        }
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      }
    },
    runSharedVectors: (contractRoot?: string): ConformanceResult[] =>
      runSharedVectors(contractRoot),
  });
};

export const COMMAND_CATALOG_FORMAT = "agent-command-catalog-1.0";

const DEFAULT_COMMANDS = Object.freeze([
  Object.freeze({
    command: "/new",
    description: "Start a new conversation thread",
    argumentHint: "[title]",
  }),
]);

const commandCatalog = (languageCode: string): Readonly<Record<string, unknown>> => {
  const fingerprint = createHash("sha256")
    .update(canonicalJson({ format: COMMAND_CATALOG_FORMAT, commands: DEFAULT_COMMANDS }), "utf8")
    .digest("hex")
    .slice(0, 16);
  return {
    format: COMMAND_CATALOG_FORMAT,
    catalogVersion: `cmdcat_${fingerprint}`,
    languageCode,
    commands: DEFAULT_COMMANDS,
  };
};
