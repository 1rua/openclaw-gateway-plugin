import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { nextAttachmentState, type AttachmentState } from "../../../../gateway-contract/src/state-machines.js";
import type { AccountPaths } from "./account-paths.js";
import type { GatewayAccountStore } from "./account-store.js";
import { DEFAULT_ATTACHMENT_POLICY, type AttachmentPolicy } from "./attachment-policy.js";
import { AuditStore } from "./audit-store.js";
import {
  decryptAttachmentStream,
  encryptAttachmentStream,
  fsyncAttachmentDirectory,
  verifyEncryptedAttachmentFile,
  type StreamIntegrity,
} from "./attachment-crypto.js";

const stageRecoverableStates: readonly AttachmentState[] = [
  "created",
  "uploading",
  "verified",
  "delivered",
  "failed",
];

const cleanupStates: readonly AttachmentState[] = ["acknowledged", "failed", "expired"];

/**
 * The predicate §13 "未确认附件" selects.
 *
 * A host that acknowledged an attachment confirmed it; anything that is not
 * acknowledged and not already the bodyless terminal `deleted` record may still
 * hold staged device content, so 解除配对 removes it with its bytes. The same
 * predicate is used to *measure* the post-condition, which is why it is spelled
 * once here: the reported flag can never disagree with what was swept.
 */
const UNCONFIRMED_PREDICATE = "acknowledged_at IS NULL AND state != 'deleted'";

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
  readonly ready: Promise<void>;

  constructor(
    private readonly accountId: string,
    private readonly paths: AccountPaths,
    private readonly store: GatewayAccountStore,
    private readonly audit: AuditStore,
    private readonly policy: AttachmentPolicy = DEFAULT_ATTACHMENT_POLICY,
    private readonly masterKey?: Uint8Array,
  ) {
    this.ready = this.migrateLegacyStagesAsync().then(() => { this.reconcileStagedFiles(); });
  }

  get attachmentPolicy(): AttachmentPolicy {
    return this.policy;
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
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error("SCHEMA_INVALID");
    return this.store.transaction(() => {
      const existing = this.store.database
        .prepare("SELECT * FROM attachments WHERE client_attachment_key = ?")
        .get(`client:${input.clientAttachmentId}`) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        if (
          String(existing.filename) !== input.filename
          || String(existing.media_type) !== input.mediaType
          || Number(existing.size_bytes) !== input.sizeBytes
          || String(existing.sha256) !== input.sha256
        ) throw new Error("IDEMPOTENCY_CONFLICT");
        return this.mapRow(existing);
      }
      const attachmentId = `att_${randomUUID()}`;
      const now = input.now ?? new Date();
      // A caller inside the host may pass an explicit expiry (the TTL sweep is
      // tested that way); the wire boundary is where a client-supplied expiry is
      // bounded by the negotiated TTL.
      const expiresAt = input.expiresAt ?? new Date(now.getTime() + this.policy.attachmentTtlSeconds * 1000).toISOString();
      this.store.database
        .prepare(`
          INSERT INTO attachments(
            attachment_id, client_attachment_id, client_attachment_key, filename, media_type, size_bytes, sha256,
            state, content_path, created_at, expires_at, delivered_at, acknowledged_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'created', NULL, ?, ?, NULL, NULL)
        `)
        .run(
          attachmentId,
          input.clientAttachmentId,
          `client:${input.clientAttachmentId}`,
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
    });
  }

  async uploadContent(attachmentId: string, bytes: Uint8Array): Promise<AttachmentRecord> {
    async function* oneChunk(): AsyncGenerator<Uint8Array> { yield bytes; }
    return await this.uploadContentStream(attachmentId, oneChunk(), { contentLength: bytes.byteLength });
  }

  async uploadContentStream(
    attachmentId: string,
    source: AsyncIterable<Uint8Array>,
    input: Readonly<{ contentLength: number; sha256?: string }>,
  ): Promise<AttachmentRecord> {
    const current = this.getRow(attachmentId);
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0
      || Number(current.size_bytes) !== input.contentLength
      || (input.sha256 !== undefined && input.sha256 !== String(current.sha256))) {
      throw new Error("ATTACHMENT_DIGEST_MISMATCH");
    }
    const state = String(current.state) as AttachmentState;
    if (["uploading", "verified", "delivered"].includes(state)
      && Number(current.uploaded_size_bytes) === input.contentLength
      && String(current.uploaded_sha256 ?? "") === String(current.sha256)
      && this.optionalContentPath(current) !== null
      && existsSync(String(current.content_path))) {
      const digest = createHash("sha256");
      let actualLength = 0;
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new Error("REQUEST_BODY_INVALID");
        digest.update(chunk);
        actualLength += chunk.byteLength;
        if (!Number.isSafeInteger(actualLength)) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
      }
      const actualDigest = digest.digest("hex");
      if (
        actualLength !== input.contentLength
        || actualDigest !== String(current.sha256)
        || (input.sha256 !== undefined && actualDigest !== input.sha256)
      ) throw new Error("ATTACHMENT_DIGEST_MISMATCH");
      return this.get(attachmentId);
    }
    if (state === "acknowledged" || state === "expired" || state === "failed" || state === "deleted") {
      throw new Error("ATTACHMENT_EXPIRED");
    }
    const next = nextAttachmentState(state, "begin_upload");
    mkdirSync(this.paths.attachments, { recursive: true, mode: 0o700 });
    const contentPath = this.contentPath(attachmentId);
    const pendingPath = `${contentPath}.uploading-${randomUUID()}`;
    try {
      const integrity = await encryptAttachmentStream(this.masterKey, this.accountId, attachmentId, pendingPath, source);
      if (integrity.sizeBytes !== input.contentLength
        || integrity.sizeBytes !== Number(current.size_bytes)
        || (input.sha256 !== undefined && integrity.sha256 !== input.sha256)) {
        this.removeIfPresentSafely(pendingPath);
        throw new Error("ATTACHMENT_DIGEST_MISMATCH");
      }
      try {
        renameSync(pendingPath, contentPath);
        fsyncAttachmentDirectory(this.paths.attachments);
      } catch (error) {
        throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
      }
      try {
        this.store.transaction(() => {
          this.store.database
            .prepare(`UPDATE attachments
              SET state = ?, content_path = ?, uploaded_size_bytes = ?, uploaded_sha256 = ?
              WHERE attachment_id = ?`)
            .run(next, contentPath, integrity.sizeBytes, integrity.sha256, attachmentId);
        }, {
          onRollback: () => this.reconcileStagedFile(attachmentId, "rollback"),
        });
      } catch (error) {
        throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
      }
      return this.get(attachmentId);
    } catch (error) {
      this.removeIfPresentSafely(pendingPath);
      throw error;
    }
  }

  commit(attachmentId: string): AttachmentRecord {
    const current = this.getRow(attachmentId);
    const currentState = String(current.state) as AttachmentState;
    if (["verified", "delivered", "acknowledged"].includes(currentState)) return this.mapRow(current);
    const contentPath = this.requireContentPath(current);
    let verificationError: Error | undefined;
    let verified: StreamIntegrity | undefined;
    try {
      verified = verifyEncryptedAttachmentFile(this.masterKey, this.accountId, attachmentId, contentPath);
    } catch (error) {
      verificationError = error instanceof Error ? error : new Error("ATTACHMENT_READ_FAILED");
    }
    const digestMismatch = verified !== undefined && (
      verified.sizeBytes !== Number(current.size_bytes)
      || verified.sha256 !== String(current.sha256)
      || verified.sizeBytes !== Number(current.uploaded_size_bytes)
      || verified.sha256 !== String(current.uploaded_sha256 ?? "")
    );
    if (verificationError !== undefined || digestMismatch) {
      try {
        this.store.transaction(() => {
          this.store.database
            .prepare("UPDATE attachments SET state = ? WHERE attachment_id = ?")
            .run(nextAttachmentState(currentState, "fail"), attachmentId);
        });
      } catch (error) {
        throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
      }
      throw verificationError ?? new Error("ATTACHMENT_DIGEST_MISMATCH");
    }
    try {
      return this.store.transaction(() => {
        this.store.database
          .prepare("UPDATE attachments SET state = ? WHERE attachment_id = ?")
          .run(nextAttachmentState(currentState, "verify"), attachmentId);
        return this.get(attachmentId);
      });
    } catch (error) {
      throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
    }
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

  countUnconfirmed(): number {
    const row = this.store.database
      .prepare(`SELECT COUNT(*) AS count FROM attachments WHERE ${UNCONFIRMED_PREDICATE}`)
      .get() as { count: number };
    return row.count;
  }

  /**
   * 解除配对: removes every unconfirmed attachment with its staged bytes.
   *
   * §13 makes this a resource-level transaction, not a per-attachment state
   * jump, so the rows themselves go — the bytes are already gone and the
   * contract removes the metadata with them (`:635`). The bytes are unlinked on
   * commit: removing them inside the transaction would leave a durable row
   * pointing at a file that no longer exists if the surrounding work rolls back.
   *
   * Known limitation, stated rather than papered over: `attachments` carries no
   * device column in this schema, so the sweep is account-wide. Until a device
   * attribution column exists, an unpair also destroys another device's
   * in-flight bytes.
   */
  revokeUnconfirmed(input: Readonly<{ correlationId: string; now?: Date }>): number {
    const now = input.now ?? new Date();
    const pathsToDelete = new Set<string>();
    return this.store.transaction(() => {
      const rows = this.store.database
        .prepare(`SELECT * FROM attachments WHERE ${UNCONFIRMED_PREDICATE}`)
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        const contentPath = this.optionalContentPath(row);
        if (contentPath !== null) pathsToDelete.add(contentPath);
        this.store.database
          .prepare("DELETE FROM attachments WHERE attachment_id = ?")
          .run(String(row.attachment_id));
      }
      if (rows.length > 0) {
        this.audit.append({
          eventType: "attachment.revoked",
          actor: { accountId: this.accountId },
          subject: { scope: "unpair", revoked: rows.length },
          correlationId: input.correlationId,
          occurredAt: now.toISOString(),
        });
      }
      return rows.length;
    }, {
      onCommit: () => {
        for (const path of pathsToDelete) this.removeIfPresentSafely(path);
      },
    });
  }

  get(attachmentId: string): AttachmentRecord {
    return this.mapRow(this.getRow(attachmentId));
  }

  requireVerifiedForMessage(attachmentId: string): void {
    const record = this.get(attachmentId);
    if (record.state !== "verified") throw new Error("ATTACHMENT_EXPIRED");
  }

  openVerifiedStream(attachmentId: string): AsyncGenerator<Buffer> {
    const row = this.getRow(attachmentId);
    if (String(row.state) !== "verified") throw new Error("ATTACHMENT_EXPIRED");
    return decryptAttachmentStream(this.masterKey, this.accountId, attachmentId, this.requireContentPath(row));
  }

  async materializeVerified(attachmentId: string): Promise<Readonly<{ path: string; cleanup: () => void }>> {
    const path = join(this.paths.attachments, `${attachmentId}.${randomUUID()}.inbound`);
    const fd = openSync(path, "wx", 0o600);
    try {
      for await (const chunk of this.openVerifiedStream(attachmentId)) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
          if (written <= 0) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
          offset += written;
        }
      }
    } catch (error) {
      closeSync(fd);
      this.removeIfPresentSafely(path);
      throw error;
    }
    closeSync(fd);
    return Object.freeze({ path, cleanup: () => { this.removeIfPresentSafely(path); } });
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

  private async migrateLegacyStagesAsync(): Promise<void> {
    const paths = this.stagedPaths();
    if (paths.length === 0) return;
    for (const path of paths) {
      const fd = openSync(path, "r");
      const prefix = Buffer.alloc(8);
      try { readSync(fd, prefix, 0, prefix.byteLength, 0); } finally { closeSync(fd); }
      const attachmentId = path.slice(this.paths.attachments.length + 1, -".stage".length);
      const row = this.store.database
        .prepare("SELECT size_bytes, sha256, uploaded_size_bytes, uploaded_sha256 FROM attachments WHERE attachment_id = ?")
        .get(attachmentId) as { size_bytes: number; sha256: string; uploaded_size_bytes: number | null; uploaded_sha256: string | null } | undefined;
      if (row === undefined) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
      if (prefix.toString("ascii") === "OAIEAV1\n") {
        if (row.uploaded_size_bytes !== null && row.uploaded_sha256 !== null) continue;
        if (this.masterKey === undefined || this.masterKey.byteLength !== 32) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        const digest = createHash("sha256");
        let sizeBytes = 0;
        for await (const chunk of decryptAttachmentStream(this.masterKey, this.accountId, attachmentId, path)) {
          digest.update(chunk);
          sizeBytes += chunk.byteLength;
        }
        const sha256 = digest.digest("hex");
        if (sizeBytes !== Number(row.size_bytes) || sha256 !== String(row.sha256)) {
          throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        }
        this.store.transaction(() => {
          this.store.database
            .prepare("UPDATE attachments SET uploaded_size_bytes = ?, uploaded_sha256 = ? WHERE attachment_id = ?")
            .run(sizeBytes, sha256, attachmentId);
        });
        continue;
      }
      if (this.masterKey === undefined || this.masterKey.byteLength !== 32) {
        throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
      }
      const tempPath = `${path}.migrating-${randomUUID()}`;
      const { createReadStream } = await import("node:fs");
      try {
        const integrity = await encryptAttachmentStream(
          this.masterKey,
          this.accountId,
          attachmentId,
          tempPath,
          createReadStream(path, { highWaterMark: 64 * 1024 }) as AsyncIterable<Uint8Array>,
        );
        if (integrity.sizeBytes !== Number(row.size_bytes) || integrity.sha256 !== String(row.sha256)) {
          this.removeIfPresentSafely(tempPath);
          throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        }
        // Atomic replacement means readers observe either the old verified file
        // or the complete encrypted file, never an intermediate format.
        try {
          renameSync(tempPath, path);
          fsyncAttachmentDirectory(this.paths.attachments);
        } catch (error) {
          throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
        }
        this.store.transaction(() => {
          this.store.database
            .prepare("UPDATE attachments SET uploaded_size_bytes = ?, uploaded_sha256 = ? WHERE attachment_id = ?")
            .run(integrity.sizeBytes, integrity.sha256, attachmentId);
        });
      } catch (error) {
        this.removeIfPresentSafely(tempPath);
        throw error;
      }
    }
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
          correlationId: `attachment.acknowledged.${attachmentId}`,
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
