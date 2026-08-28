import { createHash } from "node:crypto";

import { validateGatewayValue, type GatewaySchemaName } from "../../../../gateway-contract/src/schema-registry.js";
import { accountPaths, defaultOpenClawGatewayRoot, type AccountPaths } from "./account-paths.js";
import { openAccountStore, type GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";
import { AttachmentStore } from "./attachment-store.js";
import { ConversationPort } from "./conversation-port.js";
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
  close: () => void;
}>;

export type GatewayCoreOptions = Readonly<{
  storageRoot?: string;
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

export type VerifiedGatewayRequest = Readonly<{
  context: VerifiedRequestContext;
  method: "GET" | "POST" | "PUT" | "DELETE";
  target: string;
  body?: unknown;
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
  handle: (request: VerifiedGatewayRequest) => Promise<GatewayResponse>;
  runSharedVectors: (contractRoot?: string) => ConformanceResult[];
}>;

export type { ConformanceResult, ConformanceVectorOperation };

const success = (
  request: VerifiedGatewayRequest,
  data: Readonly<Record<string, unknown>>,
): GatewayResponse =>
  Object.freeze({
    requestId: request.context.requestId,
    correlationId: request.context.correlationId,
    protocol: "2.0" as const,
    data,
  });

const failure = (
  request: VerifiedGatewayRequest,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayResponse =>
  Object.freeze({
    requestId: request.context.requestId,
    correlationId: request.context.correlationId,
    protocol: "2.0" as const,
    error: Object.freeze({
      code,
      message: code,
      retryable: false,
      retryAfterSeconds: null,
      details,
    }),
  });

const canonicalJson = (value: unknown): string => {
  if (value instanceof Uint8Array) return JSON.stringify({ bytesSha256: createHash("sha256").update(value).digest("hex") });
  return JSON.stringify(value ?? null);
};

const assertSchema = (schemaName: GatewaySchemaName, value: unknown): void => {
  const result = validateGatewayValue(schemaName, value);
  if (!result.ok) throw new Error("SCHEMA_INVALID");
};

const bodyRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("SCHEMA_INVALID");
  return value as Readonly<Record<string, unknown>>;
};

const protocolErrorCodes = new Set([
    "SCHEMA_INVALID",
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
  if (!(error instanceof Error) || !protocolErrorCodes.has(error.message)) return undefined;
  return error.message;
};

const assertNoIdentityOverride = (value: unknown): void => {
  if (value && typeof value === "object") {
    const encoded = JSON.stringify(value);
    if (/"(?:accountId|deviceId|principalId|pairingGeneration)"\s*:/.test(encoded)) {
      throw new Error("IDENTITY_OVERRIDE_REJECTED");
    }
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
  if (request.idempotencyKey !== request.context.requestId) return failure(request, "IDEMPOTENCY_CONFLICT");
  const now = request.now ?? new Date();
  const inputHash = createHash("sha256")
    .update(canonicalJson({ method: request.method, target: request.target, body: request.body }), "utf8")
    .digest("hex");
  return account.store.transaction(() => {
    const existing = account.store.database
      .prepare("SELECT input_hash, outcome_json, expires_at FROM idempotency_ledger WHERE device_id = ? AND request_id = ?")
      .get(request.context.deviceId, request.context.requestId) as Record<string, unknown> | undefined;
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
        request.context.deviceId,
        request.context.requestId,
        inputHash,
        JSON.stringify(response),
        new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      );
    return response;
  });
};

const buildAccount = (root: string, accountId: string): GatewayAccount => {
  const paths = accountPaths(root, accountId);
  const store = openAccountStore(paths);
  const audit = new AuditStore(store);
  const events = new EventStore(store);
  const attachments = new AttachmentStore(accountId, paths, store, audit);
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
    conversations: new ConversationPort(accountId, store, attachments, audit),
    deviceRequests: new DeviceRequestStore(accountId, store, audit, events),
    events,
    sessions: new SessionService(accountId, store, audit),
    close: store.close,
  });
};

export const createGatewayCore = (options: GatewayCoreOptions = {}): GatewayCore => {
  const root = options.storageRoot ?? defaultOpenClawGatewayRoot();
  return Object.freeze({
    openGatewayAccount: async (accountId: string): Promise<GatewayAccount> =>
      buildAccount(root, accountId),
    handle: async (request: VerifiedGatewayRequest): Promise<GatewayResponse> => {
      try {
        const account = buildAccount(root, request.context.accountId);
        try {
          assertNoIdentityOverride(request.body);
          if (request.method === "GET" && request.target.startsWith("/agent-life/v2/events")) {
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
            ? request.target.match(/^\/agent-life\/v2\/device-requests\/([^/]+)\/claim$/)
            : undefined;
          const resultMatch = request.method === "POST"
            ? request.target.match(/^\/agent-life\/v2\/device-requests\/([^/]+)\/result$/)
            : undefined;
          const validateReplay = claimMatch?.[1]
            ? () => account.deviceRequests.validateClaimReplay({
                requestId: claimMatch[1],
                deviceId: request.context.deviceId,
                pairingGeneration: request.context.pairingGeneration,
                grantRevision: request.context.grantRevision,
                now: request.now,
              })
            : resultMatch?.[1]
              ? () => {
                  const body = bodyRecord(request.body);
                  return account.deviceRequests.validateResultReplay({
                    requestId: resultMatch[1],
                    deviceId: request.context.deviceId,
                    pairingGeneration: request.context.pairingGeneration,
                    grantRevision: request.context.grantRevision,
                    claimId: String(body.claimId),
                    now: request.now,
                  });
                }
              : undefined;
          return runIdempotent(account, request, () => {
            if (request.method === "POST" && request.target === "/agent-life/v2/conversations") {
              assertSchema("conversation.create", request.body);
              const body = bodyRecord(request.body);
              return success(request, {
                conversation: account.conversations.create({
                  clientConversationId: String(body.clientConversationId),
                  title: typeof body.title === "string" ? body.title : undefined,
                  correlationId: request.context.correlationId,
                }),
              });
            }
            const messageMatch = request.target.match(/^\/agent-life\/v2\/conversations\/([^/]+)\/messages$/);
            if (request.method === "POST" && messageMatch?.[1]) {
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
                  deviceId: request.context.deviceId,
                  requestId: request.context.requestId,
                  correlationId: request.context.correlationId,
                }),
              });
            }
            if (request.method === "POST" && request.target === "/agent-life/v2/attachments") {
              assertSchema("attachment.create", request.body);
              const body = bodyRecord(request.body);
              return success(request, {
                attachment: account.attachments.create({
                  clientAttachmentId: String(body.clientAttachmentId),
                  filename: String(body.filename),
                  mediaType: String(body.mediaType),
                  sizeBytes: Number(body.sizeBytes),
                  sha256: String(body.sha256),
                  correlationId: request.context.correlationId,
                }),
              });
            }
            const attachmentContentMatch = request.target.match(/^\/agent-life\/v2\/attachments\/([^/]+)\/content$/);
            if (request.method === "PUT" && attachmentContentMatch?.[1]) {
              if (!(request.body instanceof Uint8Array)) throw new Error("SCHEMA_INVALID");
              return success(request, {
                attachment: account.attachments.uploadContent(attachmentContentMatch[1], request.body),
              });
            }
            const attachmentCommitMatch = request.target.match(/^\/agent-life\/v2\/attachments\/([^/]+)\/commit$/);
            if (request.method === "POST" && attachmentCommitMatch?.[1]) {
              return success(request, {
                attachment: account.attachments.commit(attachmentCommitMatch[1]),
              });
            }
            if (request.method === "POST" && claimMatch?.[1]) {
              return success(request, {
                receipt: account.deviceRequests.claim({
                  requestId: claimMatch[1],
                  deviceId: request.context.deviceId,
                  pairingGeneration: request.context.pairingGeneration,
                  grantRevision: request.context.grantRevision,
                  correlationId: request.context.correlationId,
                  now: request.now,
                }),
              });
            }
            if (request.method === "POST" && resultMatch?.[1]) {
              const body = bodyRecord(request.body);
              if (Number(body.grantRevision) !== request.context.grantRevision) {
                throw new Error("GRANT_STALE");
              }
              return success(request, {
                deviceRequest: account.deviceRequests.submitResult({
                  requestId: resultMatch[1],
                  deviceId: request.context.deviceId,
                  pairingGeneration: request.context.pairingGeneration,
                  grantRevision: request.context.grantRevision,
                  claimId: String(body.claimId),
                  result: body.result as { outcome: "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown" },
                  correlationId: request.context.correlationId,
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

export const openGatewayAccount = async (accountId: string): Promise<GatewayAccount> =>
  createGatewayCore().openGatewayAccount(accountId);
