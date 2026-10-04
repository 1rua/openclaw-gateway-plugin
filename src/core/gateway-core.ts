import type { GenerationCanceller } from "./conversation-workflow.js";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import canonicalize from "canonicalize";

import { coreSchemaHash } from "../../../../gateway-contract/src/core-schema-hash.js";
import { validateGatewayValue, type GatewaySchemaName } from "../../../../gateway-contract/src/schema-registry.js";
import { accountPaths, defaultOpenClawGatewayRoot, type AccountPaths } from "./account-paths.js";
import { openAccountStore, type GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";
import { AttachmentStore } from "./attachment-store.js";
import { loadAttachmentMasterKey } from "./attachment-master-key.js";
import { DEFAULT_ATTACHMENT_POLICY, type AttachmentPolicy } from "./attachment-policy.js";
import { ConversationPort } from "./conversation-port.js";
import { CredentialStore } from "./credential-store.js";
import { DeviceRequestStore } from "./device-request-store.js";
import { EventStore } from "./event-store.js";
import { HistoryMedia } from "./history-media.js";
import { PairingInvites } from "./pairing-invites.js";
import { PairingService } from "./pairing-service.js";
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
  pairings: PairingService;
  credentials: CredentialStore;
  close: () => void;
}>;

export type GatewayCoreOptions = Readonly<{
  storageRoot?: string;
  attachmentPolicy?: AttachmentPolicy;
  attachmentMasterKey?: Uint8Array;
  tlsSpkiSha256?: string;
}>;

const attachmentStatusDto = (attachment: Readonly<{
  attachmentId: string;
  state: string;
  sizeBytes: number;
  sha256: string;
}>): Readonly<Record<string, unknown>> => Object.freeze({
  attachmentId: attachment.attachmentId,
  status: attachment.state === "created" || attachment.state === "uploading"
    ? "staged"
    : attachment.state === "failed"
      ? "failed"
      : attachment.state === "expired" || attachment.state === "deleted"
        ? "expired"
        : "uploaded",
  sizeBytes: attachment.sizeBytes,
  sha256: attachment.sha256,
});

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
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  target: string;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  /** Transport peer supplied by the host, never a forwarded header or body field. */
  remoteAddress?: string;
  idempotencyKey?: string;
  lastEventId?: string;
  now?: Date;
}>;

export type GatewayResponse = Readonly<{
  requestId: string;
  correlationId: string;
  protocol: "2.1";
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
  listGatewayAccountIds?: () => string[];
  /** Whether this host registered the account; login never creates one. */
  accountExists: (accountId: string) => boolean;
  gatewayIdentity?: () => Record<string,unknown>;
  /** Recheck a verified stream binding without consuming its handshake nonce. */
  isEventSessionActive?: (context: VerifiedRequestContext, now?: Date) => boolean;
  setDeviceOnline?: (context: VerifiedRequestContext, online: boolean) => void;
  isDeviceOnline?: (accountId: string, deviceId: string, generation: number) => boolean;
  /** Resource-level removal of one logical Gateway (contract §13). */
  deleteGatewayAccount: (accountId: string) => boolean;
  setGenerationCanceller?: (cancel: GenerationCanceller) => void;
  setHostSessionResolver?: (resolver:(accountId:string,conversationId:string)=>Readonly<{storePath:string;sessionKey:string}>|undefined)=>void;
  handle: (request: VerifiedGatewayRequest) => Promise<GatewayResponse>;
  uploadAttachmentContent?: (
    request: VerifiedGatewayRequest,
    source: AsyncIterable<Uint8Array>,
    input: Readonly<{ contentLength: number; sha256: string }>,
  ) => Promise<GatewayResponse>;
  runSharedVectors: (contractRoot?: string) => ConformanceResult[];
}>;

export type { ConformanceResult, ConformanceVectorOperation };

export const GATEWAY_PROTOCOL_VERSION = Object.freeze({ major: 2, minor: 1 });

/**
 * Only capabilities this implementation actually serves are ever advertised.
 * Contract §4 keeps the base session capabilities in `messages`/`attachments`
 * and the conversation-surface ladder in `conversationUi`.
 */
export const SUPPORTED_AUTH = Object.freeze(["password", "account-invitation", "refresh", "device-key"]);
// `agent-command-new-v1` (contract §7.1) is deliberately absent: this host has
// no `/new` command entry that would atomically create a conversation and answer
// with the authoritative id, so agreeing to it would promise the phone a service
// that does not exist. The phone reads the absence and tells the user instead of
// building a conversation only it knows about.
// `agent-approval-cards-v1` (contract §7.2) is deliberately absent because this
// host has no approval-card endpoint, durable decision record or decision
// handler. A live SSE status channel does not implement those missing actions.
export const SUPPORTED_CONVERSATION_UI = Object.freeze(["agent-command-catalog-v1", "message-batches-v1", "newline-v1"]);
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
    protocol: "2.1" as const,
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
    protocol: "2.1" as const,
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
 * Names the client build and both core digests of one refused negotiation.
 *
 * A refused negotiation stops before authentication, so no session, audit row or
 * event ever records it: this line is the only trace a version mismatch leaves
 * for the operator, and it has to answer "which side is stale?" on its own.
 * Contract §4 treats a digest mismatch as a destructive upgrade, so the failure
 * must be diagnosable from the host log alone. Digests are public contract
 * hashes, never secrets, and only prefixes are printed. It never throws: it runs
 * on the failure path.
 */
const warnRefusedNegotiation = (reason: string, body: unknown): void => {
  const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  const request = asRecord(body);
  const client = asRecord(request["client"]);
  const hashes = asRecord(request["schemaHashes"]);
  // Truncating is safe without a shape re-check: this runs after
  // `negotiate.request` validation, which already pins the field to `sha256:`
  // plus 64 lowercase hex digits. A missing value still has to be named, because
  // "the client sent nothing" is exactly what an operator needs to see.
  const prefix = (value: unknown): string =>
    typeof value === "string" && value.length > 0 ? value.slice(0, 15) : "<missing>";
  console.warn(
    `[open_android] Refused negotiation: ${reason}`
    + ` (installationId=${String(client["installationId"] ?? "<missing>")}`
    + ` appVersion=${String(client["appVersion"] ?? "<missing>")}`
    + ` clientCore=${prefix(hashes["core"])} gatewayCore=${prefix(coreSchemaHash())})`,
  );
};

/**
 * The canonical path of `DELETE /pairings/current` (Wave 0 ruling D1).
 *
 * It carries no path parameter on purpose: the device being unpaired is taken
 * from the verified context only, so a body or path segment can never retarget
 * the revocation at another device (contract §6.1 `IDENTITY_OVERRIDE_REJECTED`).
 */
export const UNPAIR_TARGET = "/open-android-intelligence/v2/pairings/current";

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
  "ATTACHMENT_DIGEST_MISMATCH",
  "ATTACHMENT_STORAGE_UNAVAILABLE",
  "ATTACHMENT_EXPIRED",
  "CURSOR_CONFLICT",
  "CURSOR_EXPIRED",
  // The `DELETE /pairings/current` closure (D1). `PAIRING_REQUIRED` and the two
  // session codes are produced here; `ACCOUNT_DELETING`, `RATE_LIMITED` and
  // `HOST_INCOMPATIBLE` are *propagated* rather than generated: this host has no
  // account-deletion state machine and no rate limiter, so a verifier or host
  // layer that raises them is reported with the contract code instead of being
  // flattened into `INTERNAL_ERROR`.
  "PAIRING_REQUIRED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "ACCOUNT_DELETING",
  "RATE_LIMITED",
  "HOST_INCOMPATIBLE",
]);

/** The subset an idempotent write may record as its durable outcome. */
const persistableErrorCodes = new Set([
  "SCHEMA_INVALID",
  // D1: a refusal to unpair is a fact about the pairing, not a transient
  // failure, so the refusal is the terminal outcome of that request id. Without
  // it, a replay of an old request id that arrived *after* the device re-paired
  // would destroy the fresh pairing instead of repeating the refusal.
  "PAIRING_REQUIRED",
  "IDENTITY_OVERRIDE_REJECTED",
  "PAIRING_GENERATION_STALE",
  "GRANT_STALE",
  "IDEMPOTENCY_CONFLICT",
  "OUTCOME_UNKNOWN",
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
      return account.store.openJson(String(existing.outcome_json), `idempotency:${request.context!.deviceId}:${request.context!.requestId}`) as GatewayResponse;
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
        account.store.sealJson(response, `idempotency:${request.context!.deviceId}:${request.context!.requestId}`),
        new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      );
    return response;
  });
};

/**
 * 解除配对 for the one device the verified context names (contract §5.6, D1).
 *
 * Signature strength is the deliberate opposite of `DELETE /sessions/current`:
 * that route is waived (D4) because a device that lost its key must still be
 * able to end its own session, while this one *destroys* the pairing and
 * therefore runs only behind the host verifier's full §6.1 nine-header
 * signature and behind `runIdempotent`, which is what binds `Idempotency-Key`
 * to the signed request id. The waiver is a per-route whitelist and is never
 * generalised to this path.
 *
 * Each precondition throws instead of returning a failure so a refused unpair
 * leaves no idempotency ledger entry: nothing was revoked, so the client may
 * retry with the same key after re-pairing.
 */
const unpairCurrent = (
  request: VerifiedGatewayRequest,
  account: GatewayAccount,
): GatewayResponse => {
  const context = request.context!;
  // The endpoint takes no body; a body here can only be an attempt to smuggle
  // identity or parameters into a resource-level deletion.
  if (request.body !== undefined) throw new Error("SCHEMA_INVALID");
  // The pairing is asked about first: after a completed unpair the session is
  // gone *because* the pairing is gone, and "you have no pairing" is the answer
  // the phone needs in order to re-pair rather than to re-login.
  if (!account.pairings.hasActivePairing(context.deviceId)) throw new Error("PAIRING_REQUIRED");
  const session = account.sessions.describeSession(context.sessionId, context.deviceId, request.now);
  if (session.kind === "expired") throw new Error("SESSION_EXPIRED");
  if (session.kind === "revoked") throw new Error("SESSION_REVOKED");
  if (session.kind === "unknown") throw new Error("AUTHENTICATION_FAILED");
  const outcome = account.pairings.revoke({
    deviceId: context.deviceId,
    correlationId: context.correlationId,
    now: request.now,
  });
  const data: Readonly<Record<string, unknown>> = outcome.receipt;
  assertSchema("session.unpair", data);
  return success(request, data);
};

const buildAccount = async (
  root: string,
  accountId: string,
  policy: AttachmentPolicy,
  masterKey: Readonly<{ bytes?: Buffer; reference: string }>,
): Promise<GatewayAccount> => {
  const paths = accountPaths(root, accountId);
  const store = openAccountStore(paths, { accountId, masterKey: masterKey.bytes, reference: masterKey.reference });
  store.database.prepare(`
    INSERT INTO account_metadata(key, value) VALUES ('gateway_account_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(accountId);
  if (masterKey.bytes !== undefined) {
    const saved = store.database
      .prepare("SELECT value FROM account_metadata WHERE key = 'master_key_ref'")
      .get() as { value: string } | undefined;
    const legacyUnkeyedReference = saved?.value === "unconfigured" || saved?.value.startsWith("host-secret:");
    if (saved !== undefined && !legacyUnkeyedReference && saved.value !== masterKey.reference) {
      store.close();
      throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
    }
    store.database.prepare("UPDATE account_metadata SET value = ? WHERE key = 'master_key_ref'")
      .run(masterKey.reference);
  }
  const audit = new AuditStore(store);
  const events = new EventStore(store, policy.eventRetentionSeconds);
  const attachments = new AttachmentStore(accountId, paths, store, audit, policy, masterKey.bytes);
  try {
    await attachments.ready;
  } catch (error) {
    store.close();
    throw error;
  }
  const credentials = new CredentialStore(store);
  const sessions = new SessionService(accountId, store, audit, events, credentials);
  const deviceRequests = new DeviceRequestStore(accountId, store, audit, events);
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
    conversations: new ConversationPort(accountId, store, attachments, audit, events, policy),
    deviceRequests,
    events,
    sessions,
    pairings: new PairingService(accountId, store, audit, events, sessions, deviceRequests, attachments),
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
  const attachmentMasterKey = loadAttachmentMasterKey(options.attachmentMasterKey);
  const tlsSpkiSha256 = options.tlsSpkiSha256 ?? process.env["OPEN_ANDROID_INTELLIGENCE_GATEWAY_TLS_SPKI_SHA256"] ?? null;
  if (tlsSpkiSha256 !== null && (!/^sha256:[a-f0-9]{64}$/.test(tlsSpkiSha256) || tlsSpkiSha256 === `sha256:${"0".repeat(64)}`)) throw new Error("GATEWAY_TLS_IDENTITY_INVALID");
  let generationCanceller: GenerationCanceller | undefined;
  let hostSessionResolver:Parameters<NonNullable<GatewayCore['setHostSessionResolver']>>[0]|undefined;
  const openAccount=async(accountId:string):Promise<GatewayAccount>=> {
    const account=await buildAccount(resolveRoot(),accountId,policy,attachmentMasterKey);
    if(hostSessionResolver) account.conversations.setHostSessionResolver(hostSessionResolver);
    return account;
  };
  const activeCancellations = new Map<string,Promise<string>>();
  const activeUploads = new Map<string, Promise<GatewayResponse>>();
  // Pending negotiations are short-lived and this host has no durable cross-
  // account store for them; a restart simply requires a new negotiation.
  const pendingNegotiations = new Map<string, { installationId: string; expiresAt: number; inputHash: string }>();
  let passwordJobs = 0;
  let admissionWindow = 0;
  let negotiationCount = 0;
  const passwordAttempts = new Map<string, { window: number; count: number }>();
  const admit = (password: boolean, now: number) => {
    if (now >= admissionWindow + 60_000 || now < admissionWindow) {
      admissionWindow = now; negotiationCount = 0;
    }
    if (password ? passwordJobs >= 2 : ++negotiationCount > 1000) throw new Error("RATE_LIMITED");
  };
  const admitPassword = (request: VerifiedGatewayRequest, accountId: string, now: number) => {
    admit(true, now); // Busy retries do not spend the caller's minute allowance.
    for (const [key, entry] of passwordAttempts) {
      if (now < entry.window || now >= entry.window + 60_000) passwordAttempts.delete(key);
    }
    const key = JSON.stringify([request.remoteAddress ?? "internal", accountId]);
    const entry = passwordAttempts.get(key) ?? { window: now, count: 0 };
    if (entry.count >= 30) throw new Error("RATE_LIMITED");
    // The per-peer throttle is a bounded cache, not a deployment-wide lockout.
    // Keep admitting new peers when full; the two expensive job slots remain
    // the hard resource bound even when old throttle entries are evicted.
    passwordAttempts.delete(key);
    if (passwordAttempts.size >= 1000) passwordAttempts.delete(passwordAttempts.keys().next().value!);
    entry.count += 1;
    passwordAttempts.set(key, entry);
    passwordJobs += 1;
  };

  const negotiationResponse = (
    body: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> => {
    assertSchema("negotiate.request", body);
    const schemaHashes = bodyRecord(body["schemaHashes"]);
    if (String(schemaHashes["core"]) !== coreSchemaHash()) {
      warnRefusedNegotiation("core Schema digest mismatch", body);
      throw new Error("PROTOCOL_INCOMPATIBLE");
    }
    const requested = bodyRecord(body["features"]);
    const auth = (requested["auth"] as readonly unknown[]).filter(
      (item): item is string => typeof item === "string" && SUPPORTED_AUTH.includes(item),
    );
    // All missing capabilities are reported together, exactly as the Hermes host
    // does: one refusal is one diagnostic event, not one line per missing name.
    const offered = Object.values(requested).flat().filter((item): item is string => typeof item === "string");
    const missing = Object.values(REQUIRED_FEATURES)
      .filter((required) => !offered.includes(required))
      .sort();
    if (missing.length > 0) {
      warnRefusedNegotiation(`client does not offer ${missing.join(", ")}`, body);
      throw new Error("PROTOCOL_INCOMPATIBLE");
    }
    const conversationUi = Array.isArray(requested["conversationUi"])
      ? (requested["conversationUi"] as readonly unknown[]).filter(
          (item): item is string => typeof item === "string" && (SUPPORTED_CONVERSATION_UI.includes(item) || (item === "generation-cancel-v1" && generationCanceller !== undefined)),
        )
      : [];
    const features: Record<string, unknown> = { auth, ...REQUIRED_FEATURES };
    if (conversationUi.length > 0) features["conversationUi"] = conversationUi;
    return Object.freeze({
      protocol: { ...GATEWAY_PROTOCOL_VERSION },
      features,
      limits: {
        attachmentTtlSeconds: policy.attachmentTtlSeconds,
        eventRetentionSeconds: policy.eventRetentionSeconds,
        maxClockSkewSeconds: policy.maxClockSkewSeconds,
      },
      gatewayIdentity: {
        deploymentId: deploymentIdOf(resolveRoot()),
        tlsSpkiSha256,
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
        admit(false, now.getTime());
        for (const [id, pending] of pendingNegotiations) if (pending.expiresAt <= now.getTime()) pendingNegotiations.delete(id);
        const body = bodyRecord(request.body);
        const response = negotiationResponse(body);
        assertSchema("negotiate.response", response);
        const negotiationId = String(bodyRecord(body)["negotiationId"]);
        const inputHash = createHash("sha256")
          .update(canonicalJson({ method: request.method, target: request.target, body }), "utf8")
          .digest("hex");
        const existing = pendingNegotiations.get(negotiationId);
        if (existing !== undefined && existing.inputHash !== inputHash) {
          warnRefusedNegotiation(`${negotiationId} was already started with a different body`, body);
          throw new Error("PROTOCOL_INCOMPATIBLE");
        }
        const installationId = String(bodyRecord(body["client"])["installationId"]);
        if (existing === undefined && pendingNegotiations.size >= 1000) throw new Error("RATE_LIMITED");
        if (existing === undefined) pendingNegotiations.set(negotiationId, {
          installationId,
          expiresAt: now.getTime() + 5 * 60 * 1000,
          inputHash,
        });
        return success(request, response as Readonly<Record<string, unknown>>);
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      }
    }
    if (request.method === "POST" && ["/open-android-intelligence/v2/sessions/invite/challenge","/open-android-intelligence/v2/sessions/invite/exchange","/open-android-intelligence/v2/pairings/exchange","/open-android-intelligence/v2/sessions/device/challenge","/open-android-intelligence/v2/sessions/device"].includes(request.target)) {
      let admitted=false;
      try {
        const body=bodyRecord(request.body); const accountId=String(body.accountId ?? body.username ?? "");
        const challenge=request.target.endsWith("challenge");
        const device=request.target.includes("/sessions/device");
        const allowed=device ? ["accountId","negotiationId","installationId","deviceId"] : challenge ? ["accountId","negotiationId","code","installation"] : ["accountId","negotiationId","challengeId","signature"];
        if (device && !challenge) assertSchema("session.device",body);
        else if (Object.keys(body).sort().join() !== allowed.sort().join()) throw new Error("SCHEMA_INVALID");
        if (!accountExistsIn(resolveRoot(),accountId)) throw new Error("AUTHENTICATION_FAILED");
        const pending=pendingNegotiations.get(String(body.negotiationId));
        if (!pending || pending.expiresAt<=now.getTime()) throw new Error("PROTOCOL_INCOMPATIBLE");
        admitPassword(request,accountId,now.getTime()); admitted=true;
        const account=await openAccount(accountId);
        try {
          const service=new PairingInvites(account.store,account.sessions,accountId);
          if (device) {
            if (body.installationId!==pending.installationId) throw new Error("PROTOCOL_INCOMPATIBLE");
            if (challenge) return success(request,service.deviceChallenge(String(body.negotiationId),String(body.installationId),String(body.deviceId),now));
            const bundle=service.deviceExchange(body,identityOf(request).correlationId,now);
            const key=account.store.database.prepare("SELECT pairing_generation,grant_revision FROM device_keys WHERE device_id=?").get(bundle.deviceId) as {pairing_generation:number;grant_revision:number};
            return success(request,{...bundle,accountId,pairingGeneration:key.pairing_generation,grantRevision:key.grant_revision});
          }
          if (challenge) {
            const installation=bodyRecord(body.installation);
            if (Object.keys(installation).sort().join() !== ["installationId","displayName","devicePublicKey"].sort().join() || installation.installationId!==pending.installationId) throw new Error("PROTOCOL_INCOMPATIBLE");
            return success(request,service.challenge(String(body.code),String(body.negotiationId),installation as Parameters<PairingInvites["challenge"]>[2],now));
          }
          const bundle=service.exchange(String(body.challengeId),String(body.signature),String(body.negotiationId),identityOf(request).correlationId,now);
          return success(request,{...bundle,accountId,pairingGeneration:account.sessions.currentPairingGeneration(),grantRevision:1});
        } finally { account.close(); }
      } catch(error) { return failure(request,gatewayErrorCode(error)); }
      finally { if (admitted) passwordJobs-=1; }
    }
    if (request.method === "POST" && request.target === "/open-android-intelligence/v2/sessions/password") {
      let admitted = false;
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
        admitPassword(request, accountId, now.getTime());
        admitted = true;
        const account = await openAccount(accountId);
        try {
          const bundle = await account.sessions.createPasswordSessionAsync({
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
          const pairing = account.store.database.prepare("SELECT pairing_generation,grant_revision FROM device_keys WHERE device_id=?").get(bundle.deviceId) as {pairing_generation:number;grant_revision:number};
          return success(request, { ...bundle, accountId, pairingGeneration:pairing.pairing_generation,grantRevision:pairing.grant_revision });
        } finally {
          account.close();
        }
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      } finally {
        if (admitted) passwordJobs -= 1;
      }
    }
    if (request.method === "POST" && request.target === "/open-android-intelligence/v2/sessions/refresh") {
      try {
        const body = bodyRecord(request.body);
        assertSchema("session.refresh", body);
        const accountId = String(body["accountId"]);
        if (!accountExistsIn(resolveRoot(), accountId)) return failure(request, "AUTHENTICATION_FAILED");
        const account = await openAccount(accountId);
        try {
          const bundle = account.sessions.refresh({
            refreshCredential: String(body["refreshCredential"]),
            installationId: String(body["installationId"]),
            deviceId: String(body["deviceId"]),
            correlationId: identityOf(request).correlationId,
            now,
          });
          const pairing = account.store.database.prepare("SELECT pairing_generation,grant_revision FROM device_keys WHERE device_id=?").get(bundle.deviceId) as {pairing_generation:number;grant_revision:number};
          return success(request, { ...bundle, accountId, pairingGeneration:pairing.pairing_generation,grantRevision:pairing.grant_revision });
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
        const account = await openAccount(accountId);
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

  const listGatewayAccountIds = (): string[] => {
    const root = resolveRoot();
    let directoryNames: string[];
    try {
      directoryNames = readdirSync(root);
    } catch {
      return [];
    }
    const accountIds: string[] = [];
    for (const directoryName of directoryNames) {
      const accountDirectory = join(root, directoryName);
      try { if (!statSync(accountDirectory).isDirectory()) continue; } catch { continue; }
      const databasePath = join(accountDirectory, "gateway.sqlite");
      if (!existsSync(databasePath)) continue;
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(databasePath);
        const row = database.prepare("SELECT value FROM account_metadata WHERE key = 'gateway_account_id'")
          .get() as { value: string } | undefined;
        if (row !== undefined && accountPaths(root, row.value).root === accountDirectory) accountIds.push(row.value);
      } catch {
        // An unreadable or legacy database is excluded until it is opened through
        // the authenticated account path and receives the account identity marker.
      } finally {
        database?.close();
      }
    }
    return accountIds.sort();
  };

  const uploadAttachmentContent = async (
    request: VerifiedGatewayRequest,
    source: AsyncIterable<Uint8Array>,
    input: Readonly<{ contentLength: number; sha256: string }>,
  ): Promise<GatewayResponse> => {
    const context = request.context;
    if (context === undefined) return failure(request, "AUTHENTICATION_REQUIRED");
    const attachmentMatch = request.target.match(/^\/open-android-intelligence\/v2\/attachments\/([^/]+)\/content$/);
    if (request.method !== "PUT" || attachmentMatch?.[1] === undefined) return failure(request, "SCHEMA_INVALID");
    if (request.idempotencyKey !== context.requestId) return failure(request, "IDEMPOTENCY_CONFLICT");
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0 || !/^[0-9a-f]{64}$/u.test(input.sha256)) {
      return failure(request, "SCHEMA_INVALID");
    }
    const account = await openAccount(context.accountId);
    const attachmentId = attachmentMatch[1];
    const key = `${context.accountId}\u0000${attachmentId}`;
    const inputHash = createHash("sha256")
      .update(canonicalJson({ method: request.method, target: request.target, body: { bytesSha256: input.sha256 } }), "utf8")
      .digest("hex");
    const drain = async (): Promise<void> => { for await (const _chunk of source) { /* discard a verified retry stream without buffering */ } };
    const active = activeUploads.get(key);
    if (active !== undefined) {
      try {
        await active;
        const existing = account.store.database
          .prepare("SELECT input_hash, outcome_json FROM idempotency_ledger WHERE device_id = ? AND request_id = ?")
          .get(context.deviceId, context.requestId) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          await drain();
          if (String(existing.input_hash) === inputHash) {
            const replay = account.store.openJson(String(existing.outcome_json), `idempotency:${context.deviceId}:${context.requestId}`) as GatewayResponse;
            account.close();
            return replay;
          }
          account.close();
          return failure(request, "IDEMPOTENCY_CONFLICT");
        }
      } catch (error) {
        await drain().catch(() => undefined);
        account.close();
        return failure(request, gatewayErrorCode(error));
      }
    }

    const work = (async (): Promise<GatewayResponse> => {
      try {
        const existing = account.store.database
          .prepare("SELECT input_hash, outcome_json, expires_at FROM idempotency_ledger WHERE device_id = ? AND request_id = ?")
          .get(context.deviceId, context.requestId) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          await drain();
          if (String(existing.input_hash) !== inputHash) return failure(request, "IDEMPOTENCY_CONFLICT");
          if (Date.parse(String(existing.expires_at)) <= (request.now ?? new Date()).getTime()) return failure(request, "OUTCOME_UNKNOWN");
          return account.store.openJson(String(existing.outcome_json), `idempotency:${context.deviceId}:${context.requestId}`) as GatewayResponse;
        }
        const attachment = await account.attachments.uploadContentStream(attachmentId, source, input);
        const response = success(request, { attachment: attachmentStatusDto(attachment) });
        account.store.transaction(() => {
          account.store.database
            .prepare(`INSERT INTO idempotency_ledger(device_id, request_id, input_hash, outcome_json, expires_at)
              VALUES (?, ?, ?, ?, ?)`)
            .run(
              context.deviceId,
              context.requestId,
              inputHash,
              account.store.sealJson(response, `idempotency:${context.deviceId}:${context.requestId}`),
              new Date((request.now ?? new Date()).getTime() + 30 * 86_400_000).toISOString(),
            );
        });
        return response;
      } catch (error) {
        return failure(request, gatewayErrorCode(error));
      } finally {
        account.close();
      }
    })();
    activeUploads.set(key, work);
    try {
      return await work;
    } finally {
      if (activeUploads.get(key) === work) activeUploads.delete(key);
    }
  };

  const isEventSessionActive = (context: VerifiedRequestContext, now = new Date()): boolean => {
      let database: DatabaseSync | undefined;
      try {
        // Read the current file, not a handle to a deleted/replaced account.
        database = new DatabaseSync(accountPaths(resolveRoot(), context.accountId).database, { readOnly: true });
        const row = database.prepare(`
          SELECT s.status, s.expires_at, k.pairing_generation
          FROM access_sessions s JOIN device_keys k ON k.device_id = s.device_id
          WHERE s.session_id = ? AND s.device_id = ?
        `).get(context.sessionId, context.deviceId) as { status: string; expires_at: string; pairing_generation: number } | undefined;
        return row !== undefined && row.status === "active"
          && Date.parse(row.expires_at) > now.getTime()
          && Number(row.pairing_generation) === context.pairingGeneration;
      } catch { return false; }
      finally { database?.close(); }
    };
  const online = new Map<string,{context:VerifiedRequestContext;count:number}>();
  return Object.freeze({
    gatewayIdentity: () => ({deploymentId:deploymentIdOf(resolveRoot()),tlsSpkiSha256}),
    setGenerationCanceller: (cancel:GenerationCanceller):void => { generationCanceller=cancel; },
    setHostSessionResolver: (resolver:NonNullable<typeof hostSessionResolver>):void=> {hostSessionResolver=resolver;},
    openGatewayAccount: async (accountId: string): Promise<GatewayAccount> =>
      openAccount(accountId),
    listGatewayAccountIds,
    accountExists: (accountId: string): boolean => accountExistsIn(resolveRoot(), accountId),
    isEventSessionActive,
    setDeviceOnline: (context: VerifiedRequestContext, connected: boolean): void => {
      const key = JSON.stringify([context.accountId,context.deviceId,context.sessionId]);
      const existing = online.get(key);
      if (connected) { if (isEventSessionActive(context)) online.set(key,{context,count:(existing?.count ?? 0)+1}); }
      else if (existing && existing.count > 1) online.set(key,{context:existing.context,count:existing.count-1});
      else online.delete(key);
      if (!connected && ![...online.values()].some(({context:other}) => other.accountId===context.accountId && other.deviceId===context.deviceId && isEventSessionActive(other))
          && accountExistsIn(resolveRoot(),context.accountId)) {
        const store=openAccountStore(accountPaths(resolveRoot(),context.accountId),{accountId:context.accountId,masterKey:attachmentMasterKey.bytes,reference:attachmentMasterKey.reference});
        try {
          store.transaction(()=> {
            const rows=store.database.prepare("SELECT request_id FROM device_requests WHERE device_id=? AND pairing_generation=? AND risk='high-privilege-ephemeral' AND state='pending'").all(context.deviceId,context.pairingGeneration) as Array<{request_id:string}>;
            const events=new EventStore(store,policy.eventRetentionSeconds);
            for(const row of rows) {
              store.database.prepare("UPDATE device_requests SET state='expired',parameters_json='',result_json='',expires_at=? WHERE request_id=?").run(new Date().toISOString(),row.request_id);
              events.releaseDeviceRequest(row.request_id);
            }
          });
        } finally {store.close();}
      }
    },
    isDeviceOnline: (accountId: string, deviceId: string, generation: number): boolean => [...online.values()].some(({context}) =>
      context.accountId === accountId && context.deviceId === deviceId && context.pairingGeneration === generation && isEventSessionActive(context)),
    deleteGatewayAccount: (accountId: string): boolean => {
      // The account directory *is* the logical Gateway: database, staged and
      // confirmed attachment bytes, credentials and the account audit trail.
      const paths = accountPaths(resolveRoot(), accountId);
      if (!existsSync(paths.root)) return false;
      rmSync(paths.root, { recursive: true, force: true });
      return true;
    },
    uploadAttachmentContent,
    handle: async (request: VerifiedGatewayRequest): Promise<GatewayResponse> => {
      try {
        if (request.context === undefined) return await handlePreAuth(request);
        if (request.method === "PUT" && request.target.includes("/attachments/") && request.target.endsWith("/content")) {
          if (!(request.body instanceof Uint8Array)) return failure(request, "SCHEMA_INVALID");
          async function* source(): AsyncGenerator<Uint8Array> { yield request.body as Uint8Array; }
          const digest = createHash("sha256").update(request.body).digest("hex");
          return await uploadAttachmentContent(request, source(), {
            contentLength: request.body.byteLength,
            sha256: digest,
          });
        }
        const account = await openAccount(request.context.accountId);
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
          if (request.method === "GET" && request.target === "/open-android-intelligence/v2/sync/snapshot") {
            const baseline = account.events.append({eventType:"gateway.notice",correlationId:request.context!.correlationId,
              payload:{noticeCode:"SYNC_BASELINE"},...(request.now ? {now:request.now} : {})});
            const pending = account.store.database.prepare("SELECT request_id FROM device_requests WHERE device_id=? AND pairing_generation=? AND state IN ('pending','claimed','cancel_requested') ORDER BY created_at").all(request.context!.deviceId,request.context!.pairingGeneration);
            return success(request,{baselineCursor:baseline.eventId,conversations:account.conversations.list(),
              pendingDeviceRequests:pending.map(row => (row as {request_id:string}).request_id),pairingGeneration:request.context!.pairingGeneration,grantRevision:request.context!.grantRevision});
          }
          const currentGeneration=request.target.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)\/generations\/current$/);
          if (request.method==="GET" && currentGeneration) {
            account.conversations.get(currentGeneration[1]!);
            return success(request,{generation:account.conversations.workflow.current(currentGeneration[1]!)});
          }
          const cancelRoute=request.method === "POST" ? request.target.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)\/generations\/([^/]+)\/cancel$/) : undefined;
          if (cancelRoute) {
            const context=request.context!;
            const body=bodyRecord(request.body);
            if (Object.keys(body).join()!=="requestId" || body.requestId!==context.requestId || request.idempotencyKey!==context.requestId) throw new Error("SCHEMA_INVALID");
            const previous=account.store.database.prepare("SELECT 1 FROM idempotency_ledger WHERE device_id=? AND request_id=?").get(context.deviceId,context.requestId);
            if (previous) return runIdempotent(account,request,()=> { throw new Error("OUTCOME_UNKNOWN"); });
            const key=JSON.stringify([context.accountId,cancelRoute[2],context.deviceId]);
            let pending=activeCancellations.get(key);
            if (!pending) {
              pending=account.conversations.workflow.prepareCancel(cancelRoute[1]!,cancelRoute[2]!,context,
                generationCanceller ? ()=>generationCanceller!(context.accountId,cancelRoute[1]!,cancelRoute[2]!) : undefined);
              activeCancellations.set(key,pending);
            }
            try {
              const outcome=await pending;
              return runIdempotent(account,request,()=>success(request,account.conversations.workflow.finishCancel(cancelRoute[1]!,cancelRoute[2]!,outcome,context,request.now)));
            } finally { if (activeCancellations.get(key)===pending) activeCancellations.delete(key); }
          }
          const historyMedia=request.target.split("?")[0]!.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)\/attachments\/([^/]+)\/(metadata|cache-grant|content)$/);
          if (historyMedia) {
            account.conversations.get(historyMedia[1]!);const media=new HistoryMedia(account.store,account.accountId);
            if (request.method==="GET" && historyMedia[3]==="metadata") return success(request,{metadata:media.metadata(historyMedia[1]!,historyMedia[2]!)});
            if (request.method==="POST" && historyMedia[3]==="cache-grant") {
              if (Object.keys(bodyRecord(request.body)).length!==0) throw new Error("SCHEMA_INVALID");
              return runIdempotent(account,request,()=>success(request,media.grant(historyMedia[1]!,historyMedia[2]!,request.context!,request.now)));
            }
            if (request.method==="GET" && historyMedia[3]==="content") {
              const grant=new URL(request.target,"https://gateway.invalid").searchParams.get("grantId") ?? "";
              const content=media.content(historyMedia[1]!,historyMedia[2]!,grant,request.context!,request.now);
              return success(request,{contentBase64:Buffer.from(content.body).toString("base64"),mediaType:content.mediaType});
            }
            throw new Error("SCHEMA_INVALID");
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
            const historyGet = request.method === "GET" ? request.target.split("?")[0]!.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)\/messages$/) : undefined;
            if (historyGet?.[1] !== undefined) {
              const query = new URL(request.target, "https://gateway.invalid").searchParams;
              return success(request, await account.conversations.listMessages(historyGet[1], {
                ...(query.get("clientMessageId") ? { clientMessageId: query.get("clientMessageId")! } : {}),
                ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
                ...(query.get("limit") ? { limit: Number(query.get("limit")) } : {}),
              }));
            }
          return runIdempotent(account, request, () => {
            if (request.method === "GET" && request.target === "/open-android-intelligence/v2/pairings/current") {
              const saved = account.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(`device-grant-digest:${request.context!.deviceId}`) as {value:string} | undefined;
              return success(request,{deviceId:request.context!.deviceId,pairingGeneration:request.context!.pairingGeneration,
                grantRevision:request.context!.grantRevision,...(saved ? {grantDigest:saved.value} : {})});
            }
            if (request.method === "POST" && request.target === "/open-android-intelligence/v2/pairings/current/capabilities") {
              const body = bodyRecord(request.body);
              if (Object.keys(body).sort().join() !== ["bindings","expectedGrantRevision","localGrantRevision"].sort().join()
                || body.expectedGrantRevision !== request.context!.grantRevision || !Number.isSafeInteger(body.localGrantRevision)) throw new Error("GRANT_STALE");
              account.deviceRequests.capabilities.validatePublication(
                body.bindings as Parameters<typeof account.deviceRequests.capabilities.register>[3]);
              const digest = `sha256:${createHash("sha256").update(canonicalJson({ bindings: body.bindings, localGrantRevision: body.localGrantRevision })).digest("hex")}`;
              const key = `device-grant-digest:${request.context!.deviceId}`;
              const prior = account.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key) as { value: string } | undefined;
              const revision = prior?.value === digest ? request.context!.grantRevision : account.pairings.bumpGrantRevision({deviceId:request.context!.deviceId,correlationId:request.context!.correlationId,grantDigest:digest,now:request.now}).grantRevision;
              account.deviceRequests.capabilities.register(request.context!.deviceId,request.context!.pairingGeneration,revision,
                body.bindings as Parameters<typeof account.deviceRequests.capabilities.register>[3]);
              account.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)").run(key,digest);
              return success(request,{ grantRevision:revision,grantDigest:digest });
            }
            const deviceGet = request.method === "GET" ? request.target.match(/^\/open-android-intelligence\/v2\/device-requests\/([^/]+)$/) : undefined;
            if (deviceGet?.[1]) {
              const row = account.deviceRequests.get(deviceGet[1]);
              if (row.deviceId !== request.context!.deviceId || row.pairingGeneration !== request.context!.pairingGeneration) throw new Error("PAIRING_GENERATION_STALE");
              if (row.grantRevision !== request.context!.grantRevision) throw new Error("GRANT_STALE");
              const raw = account.store.database.prepare("SELECT capability_json,provider_json,parameters_json,created_at FROM device_requests WHERE request_id=?").get(row.requestId) as Record<string,unknown>;
              return success(request,{ request:{...row,capability:JSON.parse(String(raw.capability_json)),provider:JSON.parse(String(raw.provider_json)),
                parameters:raw.parameters_json ? account.store.openJson(String(raw.parameters_json),`device-request:${row.requestId}`) : {},createdAt:raw.created_at,
                requiresForegroundConfirmation:row.risk === "high-privilege-ephemeral" || row.risk === "write"} });
            }
            if (request.method === "DELETE" && request.target.split("?")[0] === UNPAIR_TARGET) {
              return unpairCurrent(request, account);
            }
            if (request.method === "GET" && request.target.split("?")[0] === "/open-android-intelligence/v2/commands") {
              const languageCode = new URL(`https://gateway.local${request.target}`)
                .searchParams.get("languageCode") ?? "en";
              return success(request, commandCatalog(languageCode));
            }
            if (request.method === "GET" && request.target === "/open-android-intelligence/v2/conversations") {
              return success(request, { conversations: account.conversations.list() });
            }
            const attachmentStatusMatch = request.method === "GET"
              ? request.target.split("?")[0]!.match(/^\/open-android-intelligence\/v2\/attachments\/([^/]+)$/)
              : undefined;
            if (attachmentStatusMatch?.[1] !== undefined) {
              return success(request, { attachment: attachmentStatusDto(account.attachments.get(attachmentStatusMatch[1])) });
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
            const batchMatch=request.method === "POST" ? request.target.match(/^\/open-android-intelligence\/v2\/conversations\/([^/]+)\/message-batches$/) : undefined;
            if (batchMatch) return success(request,account.conversations.workflow.acceptBatch(batchMatch[1]!,request.body,request.context!,member=>account.conversations.acceptMessage({
              ...member,conversationId:batchMatch[1]!,attachmentIds:[],deviceId:request.context!.deviceId,requestId:request.context!.requestId,correlationId:request.context!.correlationId,now:request.now,emitQueued:false
            })));
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
                attachment: attachmentStatusDto(account.attachments.create({
                  clientAttachmentId: String(body.clientAttachmentId),
                  filename: String(body.filename),
                  mediaType: String(body.mediaType),
                  sizeBytes: Number(body.sizeBytes),
                  sha256: String(body.sha256),
                  deviceId: request.context!.deviceId,
                  pairingGeneration: request.context!.pairingGeneration,
                  correlationId: request.context!.correlationId,
                })),
              });
            }
            const attachmentCommitMatch = request.target.match(/^\/open-android-intelligence\/v2\/attachments\/([^/]+)\/commit$/);
            if (request.method === "POST" && attachmentCommitMatch?.[1] !== undefined) {
              return success(request, {
                attachment: attachmentStatusDto(account.attachments.commit(attachmentCommitMatch[1])),
              });
            }
            if (request.method === "POST" && claimMatch?.[1] !== undefined) {
              return success(request, account.deviceRequests.claim({
                  requestId: claimMatch[1],
                  deviceId: request.context!.deviceId,
                  pairingGeneration: request.context!.pairingGeneration,
                  grantRevision: request.context!.grantRevision,
                  correlationId: request.context!.correlationId,
                  now: request.now,
                }));
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
