import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nextAttachmentState, type AttachmentState } from "../../../../gateway-contract/src/state-machines.js";
import type { AccountPaths } from "./account-paths.js";
import type { GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";

const stageRecoverableStates: readonly AttachmentState[] = [
  "created",
  "uploading",
  "verified",
  "delivered",
  "failed",
];

const cleanupStates: readonly AttachmentState[] = ["acknowledged", "failed", "expired"];

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
  ) {
    this.reconcileStagedFiles();
  }

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
    }, {
      onRollback: () => this.reconcileStagedFile(attachmentId, "rollback"),
    });
  }

  commit(attachmentId: string): AttachmentRecord {
    return this.store.transaction(() => {
      const current = this.getRow(attachmentId);
      const contentPath = this.requireContentPath(current);
      const bytes = readFileSync(contentPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== String(current.sha256) || bytes.byteLength !== Number(current.size_bytes)) {
        this.store.database
          .prepare("UPDATE attachments SET state = ?, content_path = ? WHERE attachment_id = ?")
          .run(nextAttachmentState(String(current.state) as AttachmentState, "fail"), contentPath, attachmentId);
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
    let contentPath: string | null = null;
    return this.store.transaction(() => {
      const current = this.getRow(attachmentId);
      contentPath = this.optionalContentPath(current);
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
    }, {
      onCommit: () => {
        if (contentPath !== null) this.removeIfPresentSafely(contentPath);
      },
    });
  }

  expireDue(now = new Date()): number {
    this.reconcileStagedFiles();
    let expired = 0;
    const rows = this.store.database
      .prepare("SELECT * FROM attachments WHERE expires_at <= ? AND state IN ('created', 'uploading', 'verified', 'delivered')")
      .all(now.toISOString()) as Record<string, unknown>[];
    for (const row of rows) {
      let contentPath: string | null = null;
      this.store.transaction(() => {
        const current = this.getRow(String(row.attachment_id));
        if (
          Date.parse(String(current.expires_at)) > now.getTime() ||
          !["created", "uploading", "verified", "delivered"].includes(String(current.state))
        ) return;
        contentPath = this.optionalContentPath(current);
        this.store.database
          .prepare("UPDATE attachments SET state = ?, content_path = NULL WHERE attachment_id = ?")
          .run(nextAttachmentState(String(current.state) as AttachmentState, "expire"), String(row.attachment_id));
        expired += 1;
      }, {
        onCommit: () => {
          if (contentPath !== null) this.removeIfPresentSafely(contentPath);
        },
      });
    }
    return expired;
  }

  cleanup(): number {
    let deletedFiles = 0;
    const pathsToDelete = new Set<string>();
    this.store.transaction(() => {
      const protectedPaths = this.reconcileStagedFiles();
      const rows = this.store.database
        .prepare("SELECT attachment_id FROM attachments WHERE content_path IS NOT NULL AND state IN ('acknowledged', 'failed', 'expired')")
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        const attachmentId = String(row.attachment_id);
        const current = this.getRow(attachmentId);
        const state = String(current.state) as AttachmentState;
        if (!cleanupStates.includes(state)) continue;
        const contentPath = this.optionalContentPath(current);
        if (contentPath === null) continue;
        this.store.database
          .prepare("UPDATE attachments SET state = ?, content_path = NULL WHERE attachment_id = ?")
          .run(nextAttachmentState(state, "cleanup"), attachmentId);
        pathsToDelete.add(contentPath);
      }

      const referencedPaths = new Set(
        (this.store.database
          .prepare("SELECT content_path FROM attachments WHERE content_path IS NOT NULL")
          .all() as Record<string, unknown>[])
          .map((row) => String(row.content_path)),
      );
      for (const stagedPath of this.stagedPaths()) {
        if (!protectedPaths.has(stagedPath) && !referencedPaths.has(stagedPath)) {
          pathsToDelete.add(stagedPath);
        }
      }
    }, {
      onCommit: () => {
        for (const path of pathsToDelete) {
          if (this.removeIfPresentSafely(path)) deletedFiles += 1;
        }
      },
    });
    return deletedFiles;
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

  private stagedPaths(): string[] {
    try {
      return readdirSync(this.paths.attachments, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".stage"))
        .map((entry) => join(this.paths.attachments, entry.name));
    } catch {
      return [];
    }
  }

  private reconcileStagedFiles(): ReadonlySet<string> {
    const protectedPaths = new Set<string>();
    for (const stagedPath of this.stagedPaths()) {
      const suffix = ".stage";
      const fileName = stagedPath.slice(this.paths.attachments.length + 1);
      const attachmentId = fileName.slice(0, -suffix.length);
      if (this.reconcileStagedFile(attachmentId, "startup")) protectedPaths.add(stagedPath);
    }
    return protectedPaths;
  }

  private reconcileStagedFile(attachmentId: string, reason: "rollback" | "startup"): boolean {
    const stagedPath = this.contentPath(attachmentId);
    if (!existsSync(stagedPath)) return false;

    let repaired = false;
    try {
      this.store.transaction(() => {
        const row = this.store.database
          .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
          .get(attachmentId) as Record<string, unknown> | undefined;
        if (row === undefined) return;
        const state = String(row.state) as AttachmentState;
        if (!stageRecoverableStates.includes(state)) return;
        const currentPath = this.optionalContentPath(row);
        const nextState = state === "created" ? "uploading" : state;
        if (currentPath === stagedPath && nextState === state) return;
        this.store.database
          .prepare("UPDATE attachments SET state = ?, content_path = ? WHERE attachment_id = ?")
          .run(nextState, stagedPath, attachmentId);
        repaired = true;
      });
    } catch {
      // Keep the deterministic stage path. A later open/cleanup scan can retry it.
      return true;
    }

    if (repaired) {
      try {
        this.audit.append({
          eventType: "attachment.staging.reconciled",
          actor: { accountId: this.accountId },
          subject: { attachmentId, reason },
          correlationId: `attachment:${attachmentId}`,
          occurredAt: new Date().toISOString(),
        });
      } catch {
        // Reconciliation metadata is best effort; the row and stage path are durable.
      }
    }
    return false;
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

  private removeIfPresent(path: string): boolean {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  private removeIfPresentSafely(path: string): boolean {
    try {
      return this.removeIfPresent(path);
    } catch {
      // The DB no longer references this path; the orphan scan can retry cleanup.
      return false;
    }
  }
}
