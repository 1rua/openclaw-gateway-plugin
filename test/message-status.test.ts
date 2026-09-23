import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";
import { accountPaths } from "../src/core/account-paths.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-message-status-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const testCore = () => createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x27) });

describe("OpenClaw queued message persistence and status", () => {
  it("persists text and ordered attachment ids and appends queued, delivered and completed status events", async () => {
    const core = testCore();
    const account = await core.openGatewayAccount("acct_status");
    const conversation = account.conversations.create({
      clientConversationId: "client_conv_status",
      correlationId: "cor_create_conversation",
      now: new Date("2026-09-23T00:00:00Z"),
    });
    const body = Buffer.from("attachment payload");
    const attachmentIds: string[] = [];
    for (const [index, mediaType] of ["application/x-agent-one", "image/heic"].entries()) {
      const attachment = account.attachments.create({
        clientAttachmentId: `client_att_${index}`,
        filename: `file-${index}.dat`,
        mediaType,
        sizeBytes: body.byteLength,
        sha256: sha256(body),
        correlationId: `cor_create_att_${index}`,
      });
      await account.attachments.uploadContent(attachment.attachmentId, body);
      account.attachments.commit(attachment.attachmentId);
      attachmentIds.push(attachment.attachmentId);
    }

    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_message_status",
      text: "please inspect these files",
      attachmentIds,
      deviceId: "device_status",
      requestId: "request_status",
      correlationId: "cor_message_status",
      now: new Date("2026-09-23T00:00:00Z"),
    });
    const stored = account.conversations.getMessage(accepted.messageId);
    expect(stored).toMatchObject({
      conversationId: conversation.conversationId,
      clientMessageId: "client_message_status",
      text: "please inspect these files",
      attachmentIds,
      status: "queued",
      revision: 0,
      errorCode: null,
    });

    const claim = account.conversations.claimNextMessage({ now: new Date("2026-09-23T00:00:00Z") });
    expect(claim?.messageId).toBe(accepted.messageId);
    account.conversations.markDelivered(accepted.messageId, "cor_agent_ack", new Date("2026-09-23T00:00:01Z"));
    expect(account.conversations.getMessage(accepted.messageId).text).toBe("");
    expect(account.conversations.acknowledgeDeliveredAttachments(accepted.messageId, "cor_attachment_ack", new Date("2026-09-23T00:00:01Z"))).toEqual([]);
    account.conversations.markCompleted(accepted.messageId, "cor_agent_complete", new Date("2026-09-23T00:00:02Z"));
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({
      status: "completed",
      revision: 2,
      errorCode: null,
      attachmentIds: [],
    });
    expect(() => account.conversations.markFailed(accepted.messageId, "MODEL_REQUEST_REJECTED", "cor_illegal_terminal_regression"))
      .toThrow("INVALID_STATE_TRANSITION");
    for (const attachmentId of attachmentIds) expect(account.attachments.get(attachmentId)).toMatchObject({ state: "acknowledged", hasStagedBytes: false });

    const events = account.events.readAfter(null).filter((event) => event.eventType === "conversation.message.status");
    expect(events.map((event) => event.payload)).toMatchObject([
      { messageId: accepted.messageId, status: "queued", revision: 0, errorCode: null },
      { messageId: accepted.messageId, status: "delivered", revision: 1, errorCode: null },
      { messageId: accepted.messageId, status: "completed", revision: 2, errorCode: null },
    ]);
    account.close();
  });

  it("retries pre-ack Agent unavailability and records stable terminal failures", async () => {
    const core = testCore();
    const account = await core.openGatewayAccount("acct_retry");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_retry", correlationId: "cor_retry_create" });
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_message_retry",
      text: "image only",
      attachmentIds: [],
      deviceId: "device_retry",
      requestId: "request_retry",
      correlationId: "cor_retry_message",
    });
    const first = account.conversations.claimNextMessage({ now: new Date("2026-09-23T00:00:00Z") });
    expect(first?.dispatchAttempts).toBe(1);
    account.conversations.markFailed(accepted.messageId, "AGENT_UNAVAILABLE", "cor_agent_unavailable", new Date("2026-09-23T00:00:01Z"));
    expect(account.conversations.claimNextMessage({ now: new Date("2026-09-23T00:00:02Z") })).toBeUndefined();
    const retry = account.conversations.claimNextMessage({ now: new Date("2026-09-23T00:00:04Z") });
    expect(retry).toMatchObject({ status: "queued", revision: 2, dispatchAttempts: 2 });
    account.conversations.markFailed(accepted.messageId, "MODEL_REQUEST_REJECTED", "cor_model_rejected", new Date("2026-09-23T00:00:05Z"));
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({ status: "failed", errorCode: "MODEL_REQUEST_REJECTED" });
    expect(account.conversations.claimNextMessage({ now: new Date("2026-09-24T00:00:00Z") })).toBeUndefined();
    account.close();
  });

  it("keeps the delivered status durable when attachment ACK cleanup fails and blocks state regression", async () => {
    const core = testCore();
    const account = await core.openGatewayAccount("acct_ack_failure");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_ack_failure", correlationId: "cor_ack_conv" });
    const bytes = Buffer.from("ack content");
    const attachment = account.attachments.create({
      clientAttachmentId: "client_ack_failure",
      filename: "image.any",
      mediaType: "image/x-openclaw",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_ack_attachment",
    });
    await account.attachments.uploadContent(attachment.attachmentId, bytes);
    account.attachments.commit(attachment.attachmentId);
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_ack_message",
      text: "inspect",
      attachmentIds: [attachment.attachmentId],
      deviceId: "device_ack_failure",
      requestId: "request_ack_failure",
      correlationId: "cor_ack_message",
    });
    account.conversations.claimNextMessage();
    account.conversations.markDelivered(accepted.messageId, "cor_ack_delivered");
    account.store.database.exec(`
      CREATE TRIGGER fail_attachment_ack
      BEFORE UPDATE OF state, content_path ON attachments
      WHEN NEW.state = 'acknowledged'
      BEGIN SELECT RAISE(ABORT, 'forced ACK failure'); END;
    `);

    expect(account.conversations.acknowledgeDeliveredAttachments(accepted.messageId, "cor_ack_cleanup"))
      .toEqual([attachment.attachmentId]);
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({ status: "delivered", revision: 1 });
    expect(account.conversations.markCompleted(accepted.messageId, "cor_ack_complete"))
      .toMatchObject({ status: "completed", revision: 2 });
    expect(account.attachments.get(attachment.attachmentId)).toMatchObject({ state: "delivered", hasStagedBytes: true });
    expect(() => account.conversations.markFailed(accepted.messageId, "MODEL_REQUEST_REJECTED", "cor_invalid_regression"))
      .toThrow("INVALID_STATE_TRANSITION");
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({ status: "completed", revision: 2, errorCode: null });
    account.close();
  });

  it("does not redispatch pre-outbox legacy messages whose body was never persisted", async () => {
    const storageRoot = tempRoot();
    const paths = accountPaths(storageRoot, "acct_legacy_messages");
    mkdirSync(paths.root, { recursive: true });
    const legacy = new DatabaseSync(paths.database);
    legacy.exec(`
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY NOT NULL,
        client_conversation_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO conversations VALUES ('conv_legacy', 'client_conv_legacy', NULL, '2026-09-20T00:00:00.000Z');
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL
      );
      INSERT INTO messages VALUES ('msg_legacy', 'conv_legacy', 'client_msg_legacy', '2026-09-20T00:00:01.000Z', '["att_missing"]');
    `);
    legacy.close();

    const core = createGatewayCore({ storageRoot, attachmentMasterKey: Buffer.alloc(32, 0x38) });
    const account = await core.openGatewayAccount("acct_legacy_messages");
    const migrated = account.store.database.prepare(`
      SELECT body, status, dispatchable FROM messages WHERE message_id = 'msg_legacy'
    `).get() as { body: string; status: string; dispatchable: number };
    expect(migrated).toEqual({ body: "", status: "queued", dispatchable: 0 });
    expect(account.conversations.claimNextMessage({ now: new Date("2026-09-25T00:00:00Z") })).toBeUndefined();
    expect(account.events.readAfter(null).filter((event) => event.eventType === "conversation.message.status")).toHaveLength(0);
    account.close();
  });

  it("expires queued transient bodies with an explicit failed status instead of retaining them indefinitely", async () => {
    const core = testCore();
    const account = await core.openGatewayAccount("acct_outbox_ttl");
    const createdAt = new Date("2026-09-20T00:00:00Z");
    const conversation = account.conversations.create({ clientConversationId: "client_conv_outbox_ttl", correlationId: "cor_outbox_ttl_conv", now: createdAt });
    const accepted = account.conversations.acceptMessage({
      conversationId: conversation.conversationId,
      clientMessageId: "client_message_outbox_ttl",
      text: "short-lived private text",
      attachmentIds: [],
      deviceId: "device_outbox_ttl",
      requestId: "request_outbox_ttl",
      correlationId: "cor_outbox_ttl_message",
      now: createdAt,
    });
    expect(account.conversations.claimNextMessage({ now: new Date("2026-09-21T00:00:00Z") })).toBeUndefined();
    expect(account.conversations.getMessage(accepted.messageId)).toMatchObject({
      status: "failed",
      errorCode: "AGENT_UNAVAILABLE",
      text: "",
      attachmentIds: [],
    });
    account.close();
  });
});
