import type { GatewayAccount } from "../core/gateway-core.js";
import type { AgentMessageFailureCode, GatewayMessage } from "../core/conversation-port.js";

export const OPENCLAW_CHANNEL_ID = "open-android-intelligence-gateway";

export type OpenClawLog = Readonly<{
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}>;

export type OpenClawInboundRuntime = Readonly<{
  inbound: Readonly<{
    run: (params: unknown) => Promise<unknown>;
    buildContext: (facts: unknown) => unknown;
    /** Unit seam; production loads the same helper from the pinned Plugin SDK subpath. */
    toInboundMediaFacts?: (media: readonly Readonly<Record<string, unknown>>[], defaults?: Readonly<Record<string, unknown>>) => readonly Readonly<Record<string, unknown>>[];
  }>;
  routing: Readonly<{ resolveAgentRoute: (input: unknown) => unknown }>;
  session: Readonly<{
    resolveStorePath: (store?: string, options?: unknown) => string;
    recordInboundSession: (input: unknown) => Promise<void>;
  }>;
  reply: Readonly<{ dispatchReplyWithBufferedBlockDispatcher: unknown }>;
}>;

export type AgentInboundMessage = GatewayMessage;

type AgentRoute = Readonly<{ agentId: string; accountId: string; sessionKey: string }>;
type InboundMediaFact = Readonly<{
  path: string;
  contentType: string;
  kind: "image" | "video" | "audio" | "document";
  messageId: string;
}>;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

const mediaKind = (contentType: string): InboundMediaFact["kind"] => {
  const classifier = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (classifier.startsWith("image/")) return "image";
  if (classifier.startsWith("video/")) return "video";
  if (classifier.startsWith("audio/")) return "audio";
  return "document";
};

/**
 * OpenClaw's official channel turn runner owns normalization and Agent
 * dispatch. This adapter contributes only the Gateway message facts and the
 * channel context; media stays as ordered local path/MIME facts.
 */
export const dispatchGatewayMessageToOpenClaw = async (input: Readonly<{
  account: GatewayAccount;
  message: AgentInboundMessage;
  channelRuntime: OpenClawInboundRuntime;
  cfg: unknown;
  gatewayAccountId: string;
  channelAccountId: string;
  log?: OpenClawLog;
}>): Promise<void> => {
  const { account, message, channelRuntime, cfg, gatewayAccountId, channelAccountId, log } = input;
  const materialized: Array<Readonly<{ path: string; cleanup: () => void }>> = [];
  let adopted = false;
  let delivered = false;
  const markAgentDelivered = (): void => {
    if (delivered) return;
    adopted = true;
    account.conversations.markDelivered(message.messageId, `openclaw.adopted.${message.messageId}`);
    delivered = true;
    const ackFailures = account.conversations.acknowledgeDeliveredAttachments(
      message.messageId,
      `openclaw.attachment-ack.${message.messageId}`,
    );
    if (ackFailures.length > 0) {
      log?.warn?.(`Open Android delivered message retained ${ackFailures.length} encrypted attachment(s) for TTL cleanup: messageId=${message.messageId}`);
    }
  };
  try {
    const attachments = message.attachmentIds.map((attachmentId) => account.attachments.get(attachmentId));
    for (const attachmentId of message.attachmentIds) {
      materialized.push(await account.attachments.materializeVerified(attachmentId));
    }
    const mediaInputs = attachments.map((attachment, index) => Object.freeze({
      path: materialized[index]!.path,
      contentType: attachment.mediaType,
      kind: mediaKind(attachment.mediaType),
      messageId: message.messageId,
    }));
    const normalizeMedia = channelRuntime.inbound.toInboundMediaFacts
      ?? (await import("openclaw/plugin-sdk/channel-inbound")).toInboundMediaFacts;
    const media = normalizeMedia(mediaInputs, { messageId: message.messageId }) as readonly InboundMediaFact[];
    const routePeer = Object.freeze({ kind: "direct", id: `${gatewayAccountId}:${message.conversationId}` });
    const raw = Object.freeze({ message, media: Object.freeze(media) });

    const run = channelRuntime.inbound.run as unknown as (params: Readonly<Record<string, unknown>>) => Promise<unknown>;
    const buildContext = channelRuntime.inbound.buildContext as unknown as (facts: Readonly<Record<string, unknown>>) => unknown;
    const resolveAgentRoute = channelRuntime.routing.resolveAgentRoute as unknown as (facts: Readonly<Record<string, unknown>>) => AgentRoute;
    const resolveStorePath = channelRuntime.session.resolveStorePath as unknown as (store?: string, options?: Readonly<Record<string, unknown>>) => string;
    const recordInboundSession = channelRuntime.session.recordInboundSession as unknown as (facts: Readonly<Record<string, unknown>>) => Promise<void>;

    const runResult = recordOf(await run({
      channel: OPENCLAW_CHANNEL_ID,
      accountId: channelAccountId,
      raw,
      onTurnAdopted: async (): Promise<void> => {
        markAgentDelivered();
      },
      adapter: {
        ingest: (event: unknown) => {
          const value = recordOf(event);
          const incoming = recordOf(value["message"]);
          return Object.freeze({
            id: String(incoming["messageId"]),
            timestamp: Date.parse(String(incoming["createdAt"])),
            rawText: String(incoming["text"] ?? ""),
            textForAgent: String(incoming["text"] ?? ""),
            raw: event,
          });
        },
        preflight: (normalized: unknown) => {
          const value = recordOf(normalized);
          const event = recordOf(value["raw"]);
          return Object.freeze({
            message: Object.freeze({
              body: String(value["rawText"] ?? ""),
              rawBody: String(value["rawText"] ?? ""),
              bodyForAgent: String(value["textForAgent"] ?? value["rawText"] ?? ""),
              commandBody: String(value["rawText"] ?? ""),
            }),
            media: event["media"],
          });
        },
        resolveTurn: async (normalized: unknown, _eventClass: unknown, preflight: unknown) => {
          const value = recordOf(normalized);
          const event = recordOf(value["raw"]);
          const gatewayMessage = recordOf(event["message"]);
          const facts = recordOf(preflight);
          const route = resolveAgentRoute({
            cfg,
            channel: OPENCLAW_CHANNEL_ID,
            accountId: channelAccountId,
            peer: routePeer,
          });
          const session = recordOf(recordOf(cfg)["session"]);
          const storePath = resolveStorePath(
            typeof session["store"] === "string" ? session["store"] : undefined,
            { agentId: route.agentId },
          );
          const timestamp = Number(value["timestamp"]);
          const messageText = String(value["rawText"] ?? "");
          const context = buildContext({
            channel: OPENCLAW_CHANNEL_ID,
            accountId: channelAccountId,
            messageId: String(gatewayMessage["messageId"]),
            messageIdFull: String(gatewayMessage["clientMessageId"]),
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            from: `android:${gatewayAccountId}`,
            sender: { id: gatewayAccountId, displayLabel: "Android" },
            conversation: {
              kind: "direct",
              id: String(gatewayMessage["conversationId"]),
              routePeer,
            },
            route: {
              agentId: route.agentId,
              accountId: route.accountId,
              routeSessionKey: route.sessionKey,
            },
            reply: { to: `${OPENCLAW_CHANNEL_ID}:${gatewayAccountId}:${String(gatewayMessage["conversationId"])}` },
            message: {
              body: messageText,
              rawBody: messageText,
              bodyForAgent: messageText,
              commandBody: messageText,
            },
            media: facts["media"],
          });
          return Object.freeze({
            cfg,
            channel: OPENCLAW_CHANNEL_ID,
            accountId: channelAccountId,
            agentId: route.agentId,
            routeSessionKey: route.sessionKey,
            storePath,
            ctxPayload: context,
            recordInboundSession: async (): Promise<void> => {
              await recordInboundSession({
                storePath,
                sessionKey: route.sessionKey,
                ctx: context,
                createIfMissing: true,
                onRecordError: (error: unknown): void => {
                  log?.warn?.(`Open Android inbound session record failed: ${error instanceof Error ? error.name : "unknown"}`);
                },
              });
            },
            dispatchReplyWithBufferedBlockDispatcher: channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
            delivery: {
              deliver: async (): Promise<void> => {
                // OpenClaw persists the response in its own session; Gateway v2.1
                // currently transports message status only, so do not copy reply
                // bodies back into transient Gateway storage or diagnostics.
                log?.info?.(`Open Android inbound Agent turn completed: messageId=${String(gatewayMessage["messageId"])}`);
              },
            },
          });
        },
      },
    }));
    if (runResult["dispatched"] !== true) {
      const admission = recordOf(runResult["admission"]);
      const reason = String(admission["reason"] ?? "");
      if (/media|attachment/iu.test(reason)) throw new Error("AGENT_MEDIA_REJECTED");
      throw new Error("AGENT_UNAVAILABLE");
    }
    if (!delivered) {
      markAgentDelivered();
    }
    account.conversations.markCompleted(message.messageId, `openclaw.completed.${message.messageId}`);
  } catch (error) {
    const observedCode = error instanceof Error && error.message === "ATTACHMENT_STORAGE_UNAVAILABLE"
      ? "ATTACHMENT_READ_FAILED"
      : error instanceof Error ? error.message : "";
    const code = adopted && !delivered
      ? "ATTACHMENT_READ_FAILED"
      : [
      "AGENT_UNAVAILABLE",
      "ATTACHMENT_READ_FAILED",
      "AGENT_MEDIA_REJECTED",
      "MODEL_REQUEST_REJECTED",
    ].includes(observedCode)
      ? observedCode as AgentMessageFailureCode
      : adopted ? "MODEL_REQUEST_REJECTED" : "AGENT_UNAVAILABLE";
    try {
      account.conversations.markFailed(message.messageId, code, `openclaw.failed.${message.messageId}`);
    } catch (statusError) {
      log?.error?.(`Open Android inbound status update failed: messageId=${message.messageId} code=${statusError instanceof Error ? statusError.name : "unknown"}`);
    }
    log?.warn?.(`Open Android inbound dispatch failed: messageId=${message.messageId} code=${code}`);
  } finally {
    for (const item of materialized) item.cleanup();
  }
};
