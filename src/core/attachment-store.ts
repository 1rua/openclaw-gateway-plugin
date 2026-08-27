import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nextAttachmentState, type AttachmentState } from "../../../../gateway-contract/src/state-machines.js";
import type { AccountPaths } from "./account-paths.js";
import type { GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";

export type AttachmentRecord = Readonly<{
  attachmentId: string;
  state: AttachmentState;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  hasStagedBytes: boolean;
  expiresAt: string;
}>;

export class AttachmentStore {
  constructor(
    private readonly accountId: string,
    private readonly paths: AccountPaths,
    private readonly store: GatewayAccountStore,
    private readonly audit: AuditStore,
  ) {}

  create(input: Readonly<{
    clientAttachmentId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    correlationId: string;
    now?: Date;
    expiresAt?: string;
  }>): AttachmentRecord {
    const attachmentId = `att_${randomUUID()}`;
    const now = input.now ?? new Date();
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + 3_600_000).toISOString();
    this.store.database
      .prepare(`
        INSERT INTO attachments(
          attachment_id, client_attachment_id, filename, media_type, size_bytes, sha256,
          state, content_path, created_at, expires_at, delivered_at, acknowledged_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'created', NULL, ?, ?, NULL, NULL)
      `)
      .run(
        attachmentId,
        input.clientAttachmentId,
        input.filename,
        input.mediaType,
        input.sizeBytes,
        input.sha256,
        now.toISOString(),
        expiresAt,
      );
    this.audit.append({
      eventType: "attachment.created",
      actor: { accountId: this.accountId },
      subject: { attachmentId, mediaType: input.mediaType, sizeBytes: input.sizeBytes },
      correlationId: input.correlationId,
      occurredAt: now.toISOString(),
    });
    return this.get(attachmentId);
  }

  uploadContent(attachmentId: string, bytes: Uint8Array): AttachmentRecord {
    return this.store.transaction(() => {
      const current = this.getRow(attachmentId);
      if (Number(current.size_bytes) !== bytes.byteLength) throw new Error("ATTACHMENT_DIGEST_MISMATCH");
      const next = nextAttachmentState(String(current.state) as AttachmentState, "begin_upload");
      const contentPath = this.contentPath(attachmentId);
      mkdirSync(this.paths.attachments, { recursive: true, mode: 0o700 });
      writeFileSync(contentPath, bytes, { mode: 0o600 });
      this.store.database
        .prepare("UPDATE attachments SET state = ?, content_path = ? WHERE attachment_id = ?")
        .run(next, contentPath, attachmentId);
      return this.get(attachmentId);
    });
  }

  commit(attachmentId: string): AttachmentRecord {
    return this.store.transaction(() => {
      const current = this.getRow(attachmentId);
      const contentPath = this.requireContentPath(current);
      const bytes = readFileSync(contentPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== String(current.sha256) || bytes.byteLength !== Number(current.size_bytes)) {
        this.removeIfPresent(contentPath);
        this.store.database
          .prepare("UPDATE attachments SET state = ?, content_path = NULL WHERE attachment_id = ?")
          .run(nextAttachmentState(String(current.state) as AttachmentState, "fail"), attachmentId);
        throw new Error("ATTACHMENT_DIGEST_MISMATCH");
      }
      this.store.database
        .prepare("UPDATE attachments SET state = ? WHERE attachment_id = ?")
        .run(nextAttachmentState(String(current.state) as AttachmentState, "verify"), attachmentId);
      return this.get(attachmentId);
    });
  }

  markDelivered(attachmentId: string, now = new Date()): AttachmentRecord {
    return this.transition(attachmentId, "deliver", "delivered_at", now);
  }

  acknowledge(attachmentId: string, correlationId: string, now = new Date()): AttachmentRecord {
    return this.store.transaction(() => {
      const current = this.getRow(attachmentId);
      const contentPath = this.optionalContentPath(current);
      if (contentPath !== null) this.removeIfPresent(contentPath);
      this.store.database
        .prepare("UPDATE attachments SET state = ?, content_path = NULL, acknowledged_at = ? WHERE attachment_id = ?")
        .run(nextAttachmentState(String(current.state) as AttachmentState, "acknowledge"), now.toISOString(), attachmentId);
      this.audit.append({
        eventType: "attachment.acknowledged",
        actor: { accountId: this.accountId },
        subject: { attachmentId },
        correlationId,
        occurredAt: now.toISOString(),
      });
      return this.get(attachmentId);
    });
  }

  expireDue(now = new Date()): number {
    let expired = 0;
    const rows = this.store.database
      .prepare("SELECT * FROM attachments WHERE expires_at <= ? AND state IN ('created', 'uploading', 'verified', 'delivered')")
      .all(now.toISOString()) as Record<string, unknown>[];
    for (const row of rows) {
      this.store.transaction(() => {
        const contentPath = this.optionalContentPath(row);
        if (contentPath !== null) this.removeIfPresent(contentPath);
        this.store.database
          .prepare("UPDATE attachments SET state = ?, content_path = NULL WHERE attachment_id = ?")
          .run(nextAttachmentState(String(row.state) as AttachmentState, "expire"), String(row.attachment_id));
        expired += 1;
      });
    }
    return expired;
  }

  get(attachmentId: string): AttachmentRecord {
    return this.mapRow(this.getRow(attachmentId));
  }

  requireVerifiedForMessage(attachmentId: string): void {
    const record = this.get(attachmentId);
    if (record.state !== "verified") throw new Error("ATTACHMENT_EXPIRED");
  }

  private transition(
    attachmentId: string,
    event: "deliver",
    timestampColumn: "delivered_at",
    now: Date,
  ): AttachmentRecord {
    return this.store.transaction(() => {
      const current = this.getRow(attachmentId);
      this.store.database
        .prepare(`UPDATE attachments SET state = ?, ${timestampColumn} = ? WHERE attachment_id = ?`)
        .run(nextAttachmentState(String(current.state) as AttachmentState, event), now.toISOString(), attachmentId);
      return this.get(attachmentId);
    });
  }

  private contentPath(attachmentId: string): string {
    return join(this.paths.attachments, `${attachmentId}.stage`);
  }

  private getRow(attachmentId: string): Record<string, unknown> {
    const row = this.store.database
      .prepare("SELECT * FROM attachments WHERE attachment_id = ?")
      .get(attachmentId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("ATTACHMENT_EXPIRED");
    return row;
  }

  private mapRow(row: Record<string, unknown>): AttachmentRecord {
    const contentPath = this.optionalContentPath(row);
    return Object.freeze({
      attachmentId: String(row.attachment_id),
      state: String(row.state) as AttachmentState,
      filename: String(row.filename),
      mediaType: String(row.media_type),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      hasStagedBytes: contentPath !== null && existsSync(contentPath),
      expiresAt: String(row.expires_at),
    });
  }

  private optionalContentPath(row: Record<string, unknown>): string | null {
    return typeof row.content_path === "string" && row.content_path.length > 0
      ? row.content_path
      : null;
  }

  private requireContentPath(row: Record<string, unknown>): string {
    const contentPath = this.optionalContentPath(row);
    if (contentPath === null || !existsSync(contentPath)) throw new Error("ATTACHMENT_EXPIRED");
    return contentPath;
  }

  private removeIfPresent(path: string): void {
    if (existsSync(path)) unlinkSync(path);
  }
}
