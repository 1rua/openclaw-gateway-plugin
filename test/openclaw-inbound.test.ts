import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore, type GatewayAccount } from "../src/core/gateway-core.js";
import type { GatewayMessage } from "../src/core/conversation-port.js";
import { dispatchGatewayMessageToOpenClaw, OPENCLAW_CHANNEL_ID, type OpenClawInboundRuntime } from "../src/host/inbound-dispatch.js";
import { createOpenAndroidIntelligenceChannel } from "../src/host/channel-adapter.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-inbound-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const normalizeMediaFacts = (
  media: readonly Readonly<Record<string, unknown>>[],
  defaults?: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] => media.map((item) => Object.freeze({
  ...item,
  ...(!item["messageId"] && defaults?.["messageId"] ? { messageId: defaults["messageId"] } : {}),
}));

describe("OpenClaw native inbound media delivery", () => {
  it("dispatches empty-body media-only messages with ordered readable media facts and acknowledges adoption", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x35) });
    const account = await core.openGatewayAccount("acct_inbound");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_inbound", correlationId: "cor_inbound_conv" });
    const content = [Buffer.from("first-image-content"), Buffer.from("second-image-content")];
    const mimeTypes = ["image/heic", "image/avif"];
    const attachmentIds: string[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const bytes = content[index]!;
      const attachment = account.attachments.create({
        clientAttachmentId: `client_inbound_${index}`,
        filename: `selected-${index}.bin`,
        mediaType: mimeTypes[index]!,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        correlationId: `cor_inbound_attachment_${index}`,
      });
      await account.attachments.uploadContent(attachment.attachmentId, bytes);
      account.attachments.commit(attachment.attachmentId);
      attachmentIds.push(attachment.attachmentId);
    }
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_media_only",
      text: "",
      attachmentIds,
      deviceId: "device_inbound",
      requestId: "request_inbound",
      correlationId: "cor_media_only",
    });
    const message = account.conversations.claimNextMessage();
    if (message === undefined) throw new Error("queued message not claimable");

    const seen: { contextFacts?: Record<string, unknown>; persisted?: boolean; replyDispatch?: boolean; bytes: Buffer[] } = { bytes: [] };
    const runtime: OpenClawInboundRuntime = {
      inbound: {
        toInboundMediaFacts: normalizeMediaFacts,
        buildContext: (facts: unknown): unknown => {
          seen.contextFacts = facts as Record<string, unknown>;
          return facts;
        },
        run: async (params: unknown): Promise<unknown> => {
          const input = params as Record<string, unknown>;
          expect(input.channel).toBe(OPENCLAW_CHANNEL_ID);
          const raw = input.raw as { message: { text: string }; media: Array<{ path: string; contentType: string }> };
          expect(raw.message.text).toBe("");
          expect(raw.media.map((item) => item.contentType)).toEqual(mimeTypes);
          seen.bytes = raw.media.map((item) => readFileSync(item.path));

          const adapter = input.adapter as Record<string, (value: unknown, eventClass?: unknown, facts?: unknown) => unknown>;
          const normalized = await adapter.ingest(raw);
          const preflight = await adapter.preflight(normalized);
          const turn = await adapter.resolveTurn(normalized, { kind: "message", canStartAgentTurn: true }, preflight) as Record<string, unknown>;
          const facts = seen.contextFacts!;
          expect(facts.media).toMatchObject([
            { path: expect.any(String), contentType: "image/heic", messageId: accepted.messageId },
            { path: expect.any(String), contentType: "image/avif", messageId: accepted.messageId },
          ]);
          expect((facts.message as Record<string, unknown>).rawBody).toBe("");
          await (turn.recordInboundSession as () => Promise<void>)();
          seen.persisted = true;
          await (input.onTurnAdopted as () => Promise<void>)();
          await ((turn.delivery as { deliver: () => Promise<void> }).deliver)();
          seen.replyDispatch = true;
          return { dispatched: true };
        },
      },
      routing: {
        resolveAgentRoute: (facts: unknown) => {
          const route = facts as { accountId: string; peer: { id: string } };
          expect(route.accountId).toBe("default");
          expect(route.peer.id).toBe(`acct_inbound:${conversation.conversationId}`);
          return { agentId: "main", accountId: route.accountId, sessionKey: "agent:main:direct:acct-inbound-conv" };
        },
      },
      session: {
        resolveStorePath: () => "/openclaw/sessions/sessions.json",
        recordInboundSession: async () => undefined,
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
    };

    await dispatchGatewayMessageToOpenClaw({
      account,
      message,
      channelRuntime: runtime,
      cfg: { session: { store: "/openclaw/sessions/sessions.json" } },
      gatewayAccountId: "acct_inbound",
      channelAccountId: "default",
    });

    expect(seen.bytes).toEqual(content);
    expect(seen.persisted).toBe(true);
    expect(seen.replyDispatch).toBe(true);
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({ status: "completed", revision: 2 });
    expect(account.attachments.get(attachmentIds[0]!).hasStagedBytes).toBe(false);
    expect(account.attachments.get(attachmentIds[1]!).hasStagedBytes).toBe(false);
    account.close();
  });

  it("starts a Gateway outbox worker that routes newly queued messages through the host inbound runner", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x35) });
    const channel = createOpenAndroidIntelligenceChannel(core);
    expect(channel.config.listAccountIds({})).toEqual(["default"]);
    const account = await core.openGatewayAccount("acct_dynamic");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_dynamic", correlationId: "cor_dynamic_conv" });
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_dynamic_message",
      text: "please process",
      attachmentIds: [],
      deviceId: "device_dynamic",
      requestId: "request_dynamic",
      correlationId: "cor_dynamic_message",
    });
    account.close();
    expect(channel.config.listAccountIds({})).toEqual(["default"]);

    const abort = new AbortController();
    const runtime: OpenClawInboundRuntime = {
      inbound: {
        toInboundMediaFacts: normalizeMediaFacts,
        buildContext: (facts: unknown): unknown => facts,
        run: async (params: unknown): Promise<unknown> => {
          const input = params as Record<string, unknown>;
          const message = input.raw as { message: { text: string }; media: unknown[] };
          expect(input.accountId).toBe("default");
          expect(message.message.text).toBe("please process");
          const adapter = input.adapter as Record<string, (value: unknown, eventClass?: unknown, facts?: unknown) => unknown>;
          const normalized = await adapter.ingest(input.raw);
          const preflight = await adapter.preflight(normalized);
          const turn = await adapter.resolveTurn(normalized, { kind: "message", canStartAgentTurn: true }, preflight) as Record<string, unknown>;
          await (turn.recordInboundSession as () => Promise<void>)();
          await (input.onTurnAdopted as () => Promise<void>)();
          await ((turn.delivery as { deliver: () => Promise<void> }).deliver)();
          return { dispatched: true };
        },
      },
      routing: { resolveAgentRoute: (facts: unknown) => {
        const route = facts as { accountId: string; peer: { id: string } };
        expect(route.accountId).toBe("default");
        expect(route.peer.id).toBe(`acct_dynamic:${conversation.conversationId}`);
        return { agentId: "main", accountId: route.accountId, sessionKey: "agent:main:direct:dynamic" };
      } },
      session: { resolveStorePath: () => "/openclaw/sessions/sessions.json", recordInboundSession: async () => undefined },
      reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
    };
    await channel.gateway?.startAccount({
      accountId: "default",
      cfg: { session: { store: "/openclaw/sessions/sessions.json" } },
      abortSignal: abort.signal,
      channelRuntime: runtime,
    });

    let state = "queued";
    for (let attempt = 0; attempt < 100 && state !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const reopened = await core.openGatewayAccount("acct_dynamic");
      state = reopened.conversations.getMessage(accepted.messageId).status;
      reopened.close();
    }
    abort.abort();
    expect(state).toBe("completed");
  });

  it("keeps user text and multiple media facts together in their submitted order", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x35) });
    const account = await core.openGatewayAccount("acct_text_media");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_text_media", correlationId: "cor_text_media_conv" });
    const source = [Buffer.from("attachment one"), Buffer.from("attachment two")];
    const types = ["image/png", "Application/X-Agent-Document; Profile=Preserved"];
    const attachmentIds: string[] = [];
    for (let index = 0; index < source.length; index += 1) {
      const bytes = source[index]!;
      const attachment = account.attachments.create({
        clientAttachmentId: `client_text_media_${index}`,
        filename: `text-media-${index}.dat`,
        mediaType: types[index]!,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        correlationId: `cor_text_media_att_${index}`,
      });
      await account.attachments.uploadContent(attachment.attachmentId, bytes);
      account.attachments.commit(attachment.attachmentId);
      attachmentIds.push(attachment.attachmentId);
    }
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_text_media_message",
      text: "Summarize both items",
      attachmentIds,
      deviceId: "device_text_media",
      requestId: "request_text_media",
      correlationId: "cor_text_media_message",
    });
    const message = account.conversations.claimNextMessage();
    if (message === undefined) throw new Error("queued message not claimable");

    let deliveredFacts: Record<string, unknown> | undefined;
    const runtime: OpenClawInboundRuntime = {
      inbound: {
        toInboundMediaFacts: normalizeMediaFacts,
        buildContext: (facts: unknown): unknown => { deliveredFacts = facts as Record<string, unknown>; return facts; },
        run: async (params: unknown): Promise<unknown> => {
          const input = params as Record<string, unknown>;
          const adapter = input.adapter as Record<string, (value: unknown, eventClass?: unknown, facts?: unknown) => unknown>;
          const normalized = await adapter.ingest(input.raw);
          const preflight = await adapter.preflight(normalized);
          const turn = await adapter.resolveTurn(normalized, { kind: "message", canStartAgentTurn: true }, preflight) as Record<string, unknown>;
          expect(deliveredFacts?.media).toMatchObject([
            { contentType: "image/png", kind: "image", messageId: accepted.messageId },
            { contentType: "Application/X-Agent-Document; Profile=Preserved", kind: "document", messageId: accepted.messageId },
          ]);
          expect((deliveredFacts?.message as Record<string, unknown>).body).toBe("Summarize both items");
          await (turn.recordInboundSession as () => Promise<void>)();
          await (input.onTurnAdopted as () => Promise<void>)();
          await ((turn.delivery as { deliver: () => Promise<void> }).deliver)();
          return { dispatched: true };
        },
      },
      routing: { resolveAgentRoute: () => ({ agentId: "main", accountId: "default", sessionKey: "agent:main:direct:text-media" }) },
      session: { resolveStorePath: () => "/openclaw/sessions/sessions.json", recordInboundSession: async () => undefined },
      reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
    };
    await dispatchGatewayMessageToOpenClaw({ account, message, channelRuntime: runtime, cfg: {}, gatewayAccountId: "acct_text_media", channelAccountId: "default" });
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({ status: "completed" });
    account.close();
  });

  it("reports host media refusal as a failed status without retrying as plain text", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x35) });
    const account = await core.openGatewayAccount("acct_media_rejected");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_media_rejected", correlationId: "cor_media_rejected_conv" });
    const bytes = Buffer.from("model cannot read this format");
    const attachment = account.attachments.create({
      clientAttachmentId: "client_unsupported_model_media",
      filename: "media.odd",
      mediaType: "image/x-agent-only",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_unsupported_model_media",
    });
    await account.attachments.uploadContent(attachment.attachmentId, bytes);
    account.attachments.commit(attachment.attachmentId);
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_media_rejected",
      text: "Please inspect",
      attachmentIds: [attachment.attachmentId],
      deviceId: "device_media_rejected",
      requestId: "request_media_rejected",
      correlationId: "cor_media_rejected_message",
    });
    const message = account.conversations.claimNextMessage();
    if (message === undefined) throw new Error("queued message not claimable");
    const runtime: OpenClawInboundRuntime = {
      inbound: {
        toInboundMediaFacts: normalizeMediaFacts,
        buildContext: (facts: unknown): unknown => facts,
        run: async (params: unknown): Promise<unknown> => {
          const raw = (params as Record<string, unknown>).raw as { message: { text: string }; media: unknown[] };
          expect(raw.message.text).toBe("Please inspect");
          expect(raw.media).toHaveLength(1);
          return { dispatched: false, admission: { kind: "drop", reason: "media-format-rejected" } };
        },
      },
      routing: { resolveAgentRoute: () => ({ agentId: "main", accountId: "default", sessionKey: "agent:main:direct:rejected" }) },
      session: { resolveStorePath: () => "/openclaw/sessions/sessions.json", recordInboundSession: async () => undefined },
      reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
    };
    await dispatchGatewayMessageToOpenClaw({ account, message, channelRuntime: runtime, cfg: {}, gatewayAccountId: "acct_media_rejected", channelAccountId: "default" });
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({ status: "failed", errorCode: "AGENT_MEDIA_REJECTED", dispatchAttempts: 1 });
    expect(account.attachments.get(attachment.attachmentId).state).toBe("verified");
    account.close();
  });

  it("reports a model request rejection after host adoption instead of retrying the turn", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x35) });
    const account = await core.openGatewayAccount("acct_model_rejected");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_model_rejected", correlationId: "cor_model_rejected_conv" });
    const bytes = Buffer.from("model input bytes");
    const attachment = account.attachments.create({
      clientAttachmentId: "client_model_attachment",
      filename: "input.jpg",
      mediaType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_model_attachment",
    });
    await account.attachments.uploadContent(attachment.attachmentId, bytes);
    account.attachments.commit(attachment.attachmentId);
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_model_rejected",
      text: "Describe this image",
      attachmentIds: [attachment.attachmentId],
      deviceId: "device_model_rejected",
      requestId: "request_model_rejected",
      correlationId: "cor_model_rejected_message",
    });
    const message = account.conversations.claimNextMessage();
    if (message === undefined) throw new Error("queued message not claimable");
    const runtime: OpenClawInboundRuntime = {
      inbound: {
        toInboundMediaFacts: normalizeMediaFacts,
        buildContext: (facts: unknown): unknown => facts,
        run: async (params: unknown): Promise<unknown> => {
          const input = params as Record<string, unknown>;
          const raw = input.raw as { media: unknown[] };
          expect(raw.media).toHaveLength(1);
          await (input.onTurnAdopted as () => Promise<void>)();
          throw new Error("MODEL_REQUEST_REJECTED");
        },
      },
      routing: { resolveAgentRoute: () => ({ agentId: "main", accountId: "default", sessionKey: "agent:main:direct:model-rejected" }) },
      session: { resolveStorePath: () => "/openclaw/sessions/sessions.json", recordInboundSession: async () => undefined },
      reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
    };
    await dispatchGatewayMessageToOpenClaw({ account, message, channelRuntime: runtime, cfg: {}, gatewayAccountId: "acct_model_rejected", channelAccountId: "default" });
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({
      status: "failed",
      errorCode: "MODEL_REQUEST_REJECTED",
      revision: 2,
    });
    expect(account.attachments.get(attachment.attachmentId)).toMatchObject({ state: "acknowledged", hasStagedBytes: false });
    expect(account.conversations.claimNextMessage()).toBeUndefined();
    account.close();
  });

  it("keeps two Gateway logical accounts in separate OpenClaw peer routes under one host channel account", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x35) });
    const queued: Array<{ accountId: string; account: GatewayAccount; message: GatewayMessage; conversationId: string }> = [];
    for (const accountId of ["acct_scope_a", "acct_scope_b"]) {
      const account = await core.openGatewayAccount(accountId);
      const conversation = account.conversations.create({ clientConversationId: "same_client_conversation", correlationId: `cor_${accountId}_conversation` });
      account.conversations.acceptMessage({
        conversationId: conversation.conversationId,
        clientMessageId: `client_${accountId}`,
        text: `message for ${accountId}`,
        attachmentIds: [],
        deviceId: `device_${accountId}`,
        requestId: `request_${accountId}`,
        correlationId: `cor_${accountId}_message`,
      });
      const message = account.conversations.claimNextMessage();
      if (message === undefined) throw new Error(`message not claimable for ${accountId}`);
      queued.push({ accountId, account, message, conversationId: conversation.conversationId });
    }

    const routedPeers: string[] = [];
    const runtime: OpenClawInboundRuntime = {
      inbound: {
        toInboundMediaFacts: normalizeMediaFacts,
        buildContext: (facts: unknown): unknown => facts,
        run: async (params: unknown): Promise<unknown> => {
          const input = params as Record<string, unknown>;
          const adapter = input.adapter as Record<string, (value: unknown, eventClass?: unknown, facts?: unknown) => unknown>;
          const normalized = await adapter.ingest(input.raw);
          const preflight = await adapter.preflight(normalized);
          const turn = await adapter.resolveTurn(normalized, { kind: "message", canStartAgentTurn: true }, preflight) as Record<string, unknown>;
          await (turn.recordInboundSession as () => Promise<void>)();
          await (input.onTurnAdopted as () => Promise<void>)();
          await ((turn.delivery as { deliver: () => Promise<void> }).deliver)();
          return { dispatched: true };
        },
      },
      routing: {
        resolveAgentRoute: (facts: unknown) => {
          const route = facts as { accountId: string; peer: { id: string } };
          expect(route.accountId).toBe("default");
          routedPeers.push(route.peer.id);
          return { agentId: "main", accountId: route.accountId, sessionKey: `agent:main:${route.peer.id}` };
        },
      },
      session: { resolveStorePath: () => "/openclaw/sessions/sessions.json", recordInboundSession: async () => undefined },
      reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
    };

    for (const item of queued) {
      await dispatchGatewayMessageToOpenClaw({
        account: item.account,
        message: item.message,
        channelRuntime: runtime,
        cfg: {},
        gatewayAccountId: item.accountId,
        channelAccountId: "default",
      });
      expect(item.account.conversations.getMessage(item.message.messageId).status).toBe("completed");
      item.account.close();
    }
    expect(routedPeers).toEqual([
      `acct_scope_a:${queued[0]!.conversationId}`,
      `acct_scope_b:${queued[1]!.conversationId}`,
    ]);
  });
});
