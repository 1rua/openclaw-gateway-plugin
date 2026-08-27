import { randomUUID } from "node:crypto";

import { AttachmentStore } from "./attachment-store.js";
import type { GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";

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

export class ConversationPort {
  constructor(
    private readonly accountId: string,
    private readonly store: GatewayAccountStore,
    private readonly attachments: AttachmentStore,
    private readonly audit: AuditStore,
  ) {}

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
        this.attachments.requireVerifiedForMessage(attachmentId);
      }

      const messageId = `msg_${randomUUID()}`;
      const accepted: AcceptedMessage = Object.freeze({
        status: "accepted",
        messageId,
        conversationId: input.conversationId,
      });
      this.store.database
        .prepare(`
          INSERT INTO messages(message_id, conversation_id, client_message_id, created_at, attachment_ids_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          messageId,
          input.conversationId,
          input.clientMessageId,
          (input.now ?? new Date()).toISOString(),
          JSON.stringify(input.attachmentIds),
        );
      this.audit.append({
        eventType: "conversation.message.accepted",
        actor: { accountId: this.accountId, deviceId: input.deviceId },
        subject: { conversationId: input.conversationId, messageId, attachmentCount: input.attachmentIds.length },
        correlationId: input.correlationId,
        occurredAt: (input.now ?? new Date()).toISOString(),
      });
      return accepted;
    });
  }
}
