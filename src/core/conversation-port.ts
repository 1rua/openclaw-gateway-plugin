import { randomUUID } from "node:crypto";

import { AttachmentStore } from "./attachment-store.js";
import type { GatewayAccountStore } from "./account-store.js";
import { DEFAULT_ATTACHMENT_POLICY, type AttachmentPolicy } from "./attachment-policy.js";
import { AuditStore } from "./audit-store.js";
import { EventStore } from "./event-store.js";

export type ConversationRecord = Readonly<{
  conversationId: string;
  clientConversationId: string;
  title: string | null;
}>;

export type AcceptedMessage = Readonly<{
  status: "accepted";
  messageId: string;
  conversationId: string;
}>;

export type AgentMessageFailureCode =
  | "AGENT_UNAVAILABLE"
  | "ATTACHMENT_READ_FAILED"
  | "AGENT_MEDIA_REJECTED"
  | "MODEL_REQUEST_REJECTED";

export type GatewayMessage = Readonly<{
  messageId: string;
  conversationId: string;
  clientMessageId: string;
  text: string;
  createdAt: string;
  attachmentIds: readonly string[];
  status: "queued" | "delivered" | "completed" | "failed";
  revision: number;
  errorCode: AgentMessageFailureCode | null;
  dispatchAttempts: number;
}>;

export class ConversationPort {
  constructor(
    private readonly accountId: string,
    private readonly store: GatewayAccountStore,
    private readonly attachments: AttachmentStore,
    private readonly audit: AuditStore,
    private readonly events: EventStore,
    private readonly policy: AttachmentPolicy = DEFAULT_ATTACHMENT_POLICY,
  ) {}

  list(): ConversationRecord[] {
    const rows = this.store.database
      .prepare("SELECT conversation_id, client_conversation_id, title FROM conversations ORDER BY conversation_id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapConversation(row));
  }

  get(conversationId: string): ConversationRecord {
    const row = this.store.database
      .prepare("SELECT conversation_id, client_conversation_id, title FROM conversations WHERE conversation_id = ?")
      .get(conversationId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("SCHEMA_INVALID");
    return this.mapConversation(row);
  }

  private mapConversation(row: Record<string, unknown>): ConversationRecord {
    return Object.freeze({
      conversationId: String(row.conversation_id),
      clientConversationId: String(row.client_conversation_id),
      title: typeof row.title === "string" ? row.title : null,
    });
  }

  create(input: Readonly<{
    clientConversationId: string;
    title?: string;
    correlationId: string;
    now?: Date;
  }>): ConversationRecord {
    const conversationId = `conv_${randomUUID()}`;
    this.store.database
      .prepare(`
        INSERT INTO conversations(conversation_id, client_conversation_id, title, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(conversationId, input.clientConversationId, input.title ?? null, (input.now ?? new Date()).toISOString());
    this.audit.append({
      eventType: "conversation.created",
      actor: { accountId: this.accountId },
      subject: { conversationId, clientConversationId: input.clientConversationId },
      correlationId: input.correlationId,
      occurredAt: (input.now ?? new Date()).toISOString(),
    });
    return Object.freeze({
      conversationId,
      clientConversationId: input.clientConversationId,
      title: input.title ?? null,
    });
  }

  acceptMessage(input: Readonly<{
    conversationId: string;
    clientMessageId: string;
    text: string;
    attachmentIds: readonly string[];
    deviceId: string;
    requestId: string;
    correlationId: string;
    now?: Date;
  }>): AcceptedMessage {
    return this.store.transaction(() => {
      const conversation = this.store.database
        .prepare("SELECT conversation_id FROM conversations WHERE conversation_id = ?")
        .get(input.conversationId);
      if (conversation === undefined) throw new Error("SCHEMA_INVALID");
      for (const attachmentId of input.attachmentIds) {
        const attachment = this.attachments.get(attachmentId);
        if (attachment.state !== "verified") throw new Error("ATTACHMENT_EXPIRED");
      }

      const messageId = `msg_${randomUUID()}`;
      const createdAt = input.now ?? new Date();
      const expiresAt = new Date(createdAt.getTime() + this.policy.attachmentTtlSeconds * 1000).toISOString();
      const accepted: AcceptedMessage = Object.freeze({
        status: "accepted",
        messageId,
        conversationId: input.conversationId,
      });
      this.store.database
        .prepare(`
          INSERT INTO messages(
            message_id, conversation_id, client_message_id, created_at, body,
            attachment_ids_json, status, status_revision, error_code, dispatch_attempts,
            dispatchable, next_attempt_at, lease_until, delivered_at, expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL, 0, 1, NULL, NULL, NULL, ?)
        `)
        .run(
          messageId,
          input.conversationId,
          input.clientMessageId,
          createdAt.toISOString(),
          input.text,
          JSON.stringify(input.attachmentIds),
          expiresAt,
        );
      this.audit.append({
        eventType: "conversation.message.accepted",
        actor: { accountId: this.accountId, deviceId: input.deviceId },
        subject: { conversationId: input.conversationId, messageId, attachmentCount: input.attachmentIds.length },
        correlationId: input.correlationId,
        occurredAt: (input.now ?? new Date()).toISOString(),
      });
      this.appendStatus({
        conversationId: input.conversationId,
        messageId,
        clientMessageId: input.clientMessageId,
        status: "queued",
        revision: 0,
        errorCode: null,
        correlationId: input.correlationId,
        now: input.now,
      });
      return accepted;
    });
  }

  claimNextMessage(input: Readonly<{ now?: Date; leaseSeconds?: number }> = {}): GatewayMessage | undefined {
    const now = input.now ?? new Date();
    const leaseUntil = new Date(now.getTime() + (input.leaseSeconds ?? 120) * 1000).toISOString();
    return this.store.transaction(() => {
      const expired = this.store.database.prepare(`
        SELECT * FROM messages
        WHERE dispatchable = 1 AND expires_at IS NOT NULL AND expires_at <= ?
          AND (status = 'queued' OR (status = 'failed' AND error_code = 'AGENT_UNAVAILABLE'
               AND next_attempt_at IS NOT NULL))
        ORDER BY expires_at ASC, message_id ASC
      `).all(now.toISOString()) as Record<string, unknown>[];
      for (const row of expired) {
        const revision = Number(row.status_revision) + 1;
        const messageId = String(row.message_id);
        this.store.database.prepare(`
          UPDATE messages SET status = 'failed', status_revision = ?, error_code = 'AGENT_UNAVAILABLE',
            next_attempt_at = NULL, lease_until = NULL, body = '', attachment_ids_json = '[]', dispatchable = 0
          WHERE message_id = ?
        `).run(revision, messageId);
        this.appendStatus({
          conversationId: String(row.conversation_id),
          messageId,
          clientMessageId: String(row.client_message_id),
          status: "failed",
          revision,
          errorCode: "AGENT_UNAVAILABLE",
          correlationId: `message.expired.${messageId}`,
          now,
        });
      }
      const row = this.store.database.prepare(`
        SELECT * FROM messages
        WHERE dispatchable = 1 AND expires_at > ? AND (
              (status = 'queued' AND (lease_until IS NULL OR lease_until <= ?))
           OR (status = 'failed' AND error_code = 'AGENT_UNAVAILABLE'
               AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? AND dispatch_attempts < 3)
        )
        ORDER BY created_at ASC, message_id ASC
        LIMIT 1
      `).get(now.toISOString(), now.toISOString(), now.toISOString()) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      const messageId = String(row.message_id);
      const status = String(row.status) as GatewayMessage["status"];
      let revision = Number(row.status_revision);
      if (status === "failed") {
        revision += 1;
        this.store.database.prepare(`
          UPDATE messages SET status = 'queued', status_revision = ?, error_code = NULL,
            next_attempt_at = NULL, lease_until = ? WHERE message_id = ?
        `).run(revision, leaseUntil, messageId);
        this.appendStatus({
          conversationId: String(row.conversation_id),
          messageId,
          clientMessageId: String(row.client_message_id),
          status: "queued",
          revision,
          errorCode: null,
          correlationId: `message.retry.${messageId}`,
          now,
        });
      } else {
        this.store.database.prepare("UPDATE messages SET lease_until = ? WHERE message_id = ?")
          .run(leaseUntil, messageId);
      }
      this.store.database.prepare("UPDATE messages SET dispatch_attempts = dispatch_attempts + 1 WHERE message_id = ?")
        .run(messageId);
      const fresh = this.store.database.prepare("SELECT * FROM messages WHERE message_id = ?")
        .get(messageId) as Record<string, unknown>;
      return this.mapMessage(fresh);
    });
  }

  markDelivered(messageId: string, correlationId: string, now = new Date()): GatewayMessage {
    return this.store.transaction(() => {
      const message = this.updateMessageStatus(messageId, "delivered", null, correlationId, now);
      for (const attachmentId of message.attachmentIds) this.attachments.markDelivered(attachmentId, now);
      return message;
    });
  }

  markCompleted(messageId: string, correlationId: string, now = new Date()): GatewayMessage {
    return this.updateMessageStatus(messageId, "completed", null, correlationId, now);
  }

  acknowledgeDeliveredAttachments(messageId: string, correlationId: string, now = new Date()): readonly string[] {
    const message = this.getMessage(messageId);
    if (message.status !== "delivered") throw new Error("INVALID_STATE_TRANSITION");
    const failed: string[] = [];
    this.store.transaction(() => {
      for (const attachmentId of message.attachmentIds) {
        try {
          this.attachments.acknowledge(attachmentId, correlationId, now);
        } catch {
          // Host adoption is already durable; TTL cleanup remains responsible
          // for any ciphertext whose ACK deletion failed.
          failed.push(attachmentId);
        }
      }
      if (failed.length === 0) {
        this.store.database.prepare("UPDATE messages SET attachment_ids_json = '[]' WHERE message_id = ?")
          .run(messageId);
      }
    });
    return Object.freeze(failed);
  }

  markFailed(
    messageId: string,
    errorCode: AgentMessageFailureCode,
    correlationId: string,
    now = new Date(),
  ): GatewayMessage {
    const row = this.store.database.prepare("SELECT status, dispatch_attempts FROM messages WHERE message_id = ?")
      .get(messageId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("SCHEMA_INVALID");
    const retryable = String(row.status) === "queued"
      && errorCode === "AGENT_UNAVAILABLE"
      && Number(row.dispatch_attempts) < 3;
    const nextAttempt = retryable ? new Date(now.getTime() + 2_000 * (2 ** Math.max(0, Number(row.dispatch_attempts) - 1))).toISOString() : null;
    return this.updateMessageStatus(messageId, "failed", errorCode, correlationId, now, nextAttempt);
  }

  getMessage(messageId: string): GatewayMessage {
    const row = this.store.database.prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("SCHEMA_INVALID");
    return this.mapMessage(row);
  }

  private updateMessageStatus(
    messageId: string,
    status: GatewayMessage["status"],
    errorCode: AgentMessageFailureCode | null,
    correlationId: string,
    now: Date,
    nextAttemptAt: string | null = null,
  ): GatewayMessage {
    return this.store.transaction(() => {
      const row = this.store.database.prepare("SELECT * FROM messages WHERE message_id = ?")
        .get(messageId) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error("SCHEMA_INVALID");
      const currentStatus = String(row.status) as GatewayMessage["status"];
      const allowed = (status === "delivered" && currentStatus === "queued")
        || (status === "completed" && currentStatus === "delivered")
        || (status === "failed" && (currentStatus === "queued" || currentStatus === "delivered"));
      if (!allowed) throw new Error("INVALID_STATE_TRANSITION");
      const revision = Number(row.status_revision) + 1;
      this.store.database.prepare(`
        UPDATE messages SET status = ?, status_revision = ?, error_code = ?, next_attempt_at = ?,
          lease_until = NULL,
          delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
          body = CASE WHEN ? = 'delivered' OR (? = 'failed' AND ? IS NULL) THEN '' ELSE body END,
          attachment_ids_json = CASE WHEN ? = 'failed' AND ? IS NULL THEN '[]' ELSE attachment_ids_json END
        WHERE message_id = ?
      `).run(
        status,
        revision,
        errorCode,
        nextAttemptAt,
        status,
        now.toISOString(),
        status,
        status,
        nextAttemptAt,
        status,
        nextAttemptAt,
        messageId,
      );
      this.appendStatus({
        conversationId: String(row.conversation_id),
        messageId,
        clientMessageId: String(row.client_message_id),
        status,
        revision,
        errorCode,
        correlationId,
        now,
      });
      return this.getMessage(messageId);
    });
  }

  private appendStatus(input: Readonly<{
    conversationId: string;
    messageId: string;
    clientMessageId: string;
    status: GatewayMessage["status"];
    revision: number;
    errorCode: AgentMessageFailureCode | null;
    correlationId: string;
    now?: Date;
  }>): void {
    this.events.append({
      eventType: "conversation.message.status",
      correlationId: input.correlationId,
      payload: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        clientMessageId: input.clientMessageId,
        status: input.status,
        revision: input.revision,
        errorCode: input.errorCode,
      },
      now: input.now,
    });
  }

  private mapMessage(row: Record<string, unknown>): GatewayMessage {
    const error = row.error_code;
    return Object.freeze({
      messageId: String(row.message_id),
      conversationId: String(row.conversation_id),
      clientMessageId: String(row.client_message_id),
      text: String(row.body),
      createdAt: String(row.created_at),
      attachmentIds: Object.freeze(JSON.parse(String(row.attachment_ids_json)) as string[]),
      status: String(row.status) as GatewayMessage["status"],
      revision: Number(row.status_revision),
      errorCode: typeof error === "string" ? error as AgentMessageFailureCode : null,
      dispatchAttempts: Number(row.dispatch_attempts),
    });
  }

  /**
   * The single writer of a conversation title.
   *
   * Only a conversation that exists can be renamed, and the rename is audited in
   * the same transaction as the row update so a reader can never see a title the
   * audit trail does not know about. The response shape mirrors the Hermes host's
   * `update_title` result field for field.
   */
  updateTitle(input: Readonly<{
    conversationId: string;
    title: string;
    correlationId: string;
    now?: Date;
  }>): ConversationRecord {
    return this.store.transaction(() => {
      const row = this.store.database
        .prepare("SELECT conversation_id, client_conversation_id, title FROM conversations WHERE conversation_id = ?")
        .get(input.conversationId) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error("SCHEMA_INVALID");
      this.store.database
        .prepare("UPDATE conversations SET title = ? WHERE conversation_id = ?")
        .run(input.title, input.conversationId);
      this.audit.append({
        eventType: "conversation.title.updated",
        actor: { accountId: this.accountId },
        subject: { conversationId: input.conversationId, title: input.title },
        correlationId: input.correlationId,
        occurredAt: (input.now ?? new Date()).toISOString(),
      });
      return Object.freeze({
        conversationId: input.conversationId,
        clientConversationId: String(row.client_conversation_id),
        title: input.title,
      });
    });
  }
}
