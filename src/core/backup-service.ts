import { createHash } from "node:crypto";

import { accountPaths, defaultOpenClawGatewayRoot } from "./account-paths.js";
import { openAccountStore } from "./account-store.js";
import { AuditStore, type AuditRecord } from "./audit-store.js";

export type PortableBackup = Readonly<{
  format: "open-android-intelligence-gateway-portable-backup-v1";
  accountId: string;
  exportedAt: string;
  masterKeyContinuitySha256: string;
  attachments: readonly Readonly<{
    attachmentId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    state: string;
  }>[];
  conversations: readonly Readonly<{
    conversationId: string;
    clientConversationId: string;
    title: string | null;
  }>[];
  audit: readonly AuditRecord[];
}>;

export class GatewayBackupService {
  private readonly storageRoot: string;

  constructor(options: Readonly<{ storageRoot?: string }> = {}) {
    this.storageRoot = options.storageRoot ?? defaultOpenClawGatewayRoot();
  }

  async exportPortable(accountId: string, now = new Date()): Promise<PortableBackup> {
    const paths = accountPaths(this.storageRoot, accountId);
    const store = openAccountStore(paths);
    try {
      const masterKeyRef = String(
        (store.database
          .prepare("SELECT value FROM account_metadata WHERE key = 'master_key_ref'")
          .get() as { value: string }).value,
      );
      const attachments = store.database
        .prepare(`
          SELECT attachment_id, filename, media_type, size_bytes, sha256, state
          FROM attachments
          WHERE state IN ('verified', 'delivered', 'acknowledged', 'failed', 'expired', 'deleted')
          ORDER BY attachment_id ASC
        `)
        .all()
        .map((row: unknown) => {
          const record = row as Record<string, unknown>;
          return Object.freeze({
            attachmentId: String(record.attachment_id),
            filename: String(record.filename),
            mediaType: String(record.media_type),
            sizeBytes: Number(record.size_bytes),
            sha256: String(record.sha256),
            state: String(record.state),
          });
        });
      const conversations = store.database
        .prepare(`
          SELECT conversation_id, client_conversation_id, title
          FROM conversations
          ORDER BY conversation_id ASC
        `)
        .all()
        .map((row: unknown) => {
          const record = row as Record<string, unknown>;
          return Object.freeze({
            conversationId: String(record.conversation_id),
            clientConversationId: String(record.client_conversation_id),
            title: record.title === null ? null : String(record.title),
          });
        });
      return Object.freeze({
        format: "open-android-intelligence-gateway-portable-backup-v1" as const,
        accountId,
        exportedAt: now.toISOString(),
        masterKeyContinuitySha256: createHash("sha256").update(masterKeyRef, "utf8").digest("hex"),
        attachments,
        conversations,
        audit: new AuditStore(store).list(),
      });
    } finally {
      store.close();
    }
  }
}
