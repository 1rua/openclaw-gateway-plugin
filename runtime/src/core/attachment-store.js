import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { nextAttachmentState } from "../../gateway-contract/src/state-machines.js";
import { DEFAULT_ATTACHMENT_POLICY } from "./attachment-policy.js";
import { decryptAttachmentStream, encryptAttachmentStream, fsyncAttachmentDirectory, verifyEncryptedAttachmentFile, } from "./attachment-crypto.js";
const stageRecoverableStates = [
    "created",
    "uploading",
    "verified",
    "delivered",
    "failed",
];
const cleanupStates = ["acknowledged", "failed", "expired"];
const UNATTRIBUTED_INTERNAL_OWNER = "__gateway_internal_unattributed__";
/**
 * The predicate §13 "未确认附件" selects for the pairing being revoked.
 *
 * A host that acknowledged an attachment confirmed it; anything that is not
 * acknowledged and not already the bodyless terminal `deleted` record may still
 * hold staged device content, so 解除配对 removes it with its bytes. The same
 * predicate is used to *measure* the post-condition, which is why it is spelled
 * once here: the reported flag can never disagree with what was swept.
 */
const UNCONFIRMED_PREDICATE = "acknowledged_at IS NULL AND state != 'deleted'";
export class AttachmentStore {
    accountId;
    paths;
    store;
    audit;
    policy;
    masterKey;
    ready;
    constructor(accountId, paths, store, audit, policy = DEFAULT_ATTACHMENT_POLICY, masterKey) {
        this.accountId = accountId;
        this.paths = paths;
        this.store = store;
        this.audit = audit;
        this.policy = policy;
        this.masterKey = masterKey;
        this.ready = this.migrateLegacyStagesAsync().then(() => { this.reconcileStagedFiles(); });
    }
    get attachmentPolicy() {
        return this.policy;
    }
    create(input) {
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
            throw new Error("SCHEMA_INVALID");
        const ownerDeviceId = input.deviceId ?? UNATTRIBUTED_INTERNAL_OWNER;
        const ownerPairingGeneration = input.pairingGeneration ?? 0;
        if (ownerDeviceId.length === 0 || !Number.isSafeInteger(ownerPairingGeneration) || ownerPairingGeneration < 0) {
            throw new Error("SCHEMA_INVALID");
        }
        return this.store.transaction(() => {
            const existing = this.store.database
                .prepare("SELECT * FROM attachments WHERE client_attachment_key = ?")
                .get(`client:${input.clientAttachmentId}`);
            if (existing !== undefined) {
                if (String(existing.filename) !== input.filename
                    || String(existing.media_type) !== input.mediaType
                    || Number(existing.size_bytes) !== input.sizeBytes
                    || String(existing.sha256) !== input.sha256
                    || String(existing.owner_device_id ?? "") !== ownerDeviceId
                    || Number(existing.owner_pairing_generation ?? -1) !== ownerPairingGeneration)
                    throw new Error("IDEMPOTENCY_CONFLICT");
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
            attachment_id, client_attachment_id, client_attachment_key, owner_device_id, owner_pairing_generation,
            filename, media_type, size_bytes, sha256,
            state, content_path, created_at, expires_at, delivered_at, acknowledged_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', NULL, ?, ?, NULL, NULL)
        `)
                .run(attachmentId, input.clientAttachmentId, `client:${input.clientAttachmentId}`, ownerDeviceId, ownerPairingGeneration, input.filename, input.mediaType, input.sizeBytes, input.sha256, now.toISOString(), expiresAt);
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
    async uploadContent(attachmentId, bytes) {
        async function* oneChunk() { yield bytes; }
        return await this.uploadContentStream(attachmentId, oneChunk(), { contentLength: bytes.byteLength });
    }
    async uploadContentStream(attachmentId, source, input) {
        const current = this.getRow(attachmentId);
        if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0
            || Number(current.size_bytes) !== input.contentLength
            || (input.sha256 !== undefined && input.sha256 !== String(current.sha256))) {
            throw new Error("ATTACHMENT_DIGEST_MISMATCH");
        }
        const state = String(current.state);
        if (["uploading", "verified", "delivered"].includes(state)
            && Number(current.uploaded_size_bytes) === input.contentLength
            && String(current.uploaded_sha256 ?? "") === String(current.sha256)
            && this.optionalContentPath(current) !== null
            && existsSync(String(current.content_path))) {
            const digest = createHash("sha256");
            let actualLength = 0;
            for await (const chunk of source) {
                if (!(chunk instanceof Uint8Array))
                    throw new Error("REQUEST_BODY_INVALID");
                digest.update(chunk);
                actualLength += chunk.byteLength;
                if (!Number.isSafeInteger(actualLength))
                    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
            }
            const actualDigest = digest.digest("hex");
            if (actualLength !== input.contentLength
                || actualDigest !== String(current.sha256)
                || (input.sha256 !== undefined && actualDigest !== input.sha256))
                throw new Error("ATTACHMENT_DIGEST_MISMATCH");
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
            }
            catch (error) {
                throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
            }
            try {
                this.store.transaction(() => {
                    this.store.database
                        .prepare(`UPDATE attachments
              SET state = ?, content_path = ?, uploaded_size_bytes = ?, uploaded_sha256 = ?,
                  storage_revision = storage_revision + 1
              WHERE attachment_id = ?`)
                        .run(next, contentPath, integrity.sizeBytes, integrity.sha256, attachmentId);
                }, {
                    onRollback: () => this.reconcileStagedFile(attachmentId, "rollback"),
                });
            }
            catch (error) {
                throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
            }
            return this.get(attachmentId);
        }
        catch (error) {
            this.removeIfPresentSafely(pendingPath);
            throw error;
        }
    }
    commit(attachmentId) {
        const current = this.getRow(attachmentId);
        const currentState = String(current.state);
        if (["verified", "delivered", "acknowledged"].includes(currentState))
            return this.mapRow(current);
        const contentPath = this.requireContentPath(current);
        let verificationError;
        let verified;
        try {
            verified = verifyEncryptedAttachmentFile(this.masterKey, this.accountId, attachmentId, contentPath);
        }
        catch (error) {
            verificationError = error instanceof Error ? error : new Error("ATTACHMENT_READ_FAILED");
        }
        const digestMismatch = verified !== undefined && (verified.sizeBytes !== Number(current.size_bytes)
            || verified.sha256 !== String(current.sha256)
            || verified.sizeBytes !== Number(current.uploaded_size_bytes)
            || verified.sha256 !== String(current.uploaded_sha256 ?? ""));
        if (verificationError !== undefined || digestMismatch) {
            try {
                this.store.transaction(() => {
                    this.store.database
                        .prepare("UPDATE attachments SET state = ?, storage_revision = storage_revision + 1 WHERE attachment_id = ?")
                        .run(nextAttachmentState(currentState, "fail"), attachmentId);
                });
            }
            catch (error) {
                throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
            }
            throw verificationError ?? new Error("ATTACHMENT_DIGEST_MISMATCH");
        }
        try {
            return this.store.transaction(() => {
                this.store.database
                    .prepare("UPDATE attachments SET state = ?, storage_revision = storage_revision + 1 WHERE attachment_id = ?")
                    .run(nextAttachmentState(currentState, "verify"), attachmentId);
                return this.get(attachmentId);
            });
        }
        catch (error) {
            throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
        }
    }
    markDelivered(attachmentId, now = new Date()) {
        return this.transition(attachmentId, "deliver", "delivered_at", now);
    }
    acknowledge(attachmentId, correlationId, now = new Date()) {
        let contentPath = null;
        return this.store.transaction(() => {
            const current = this.getRow(attachmentId);
            contentPath = this.optionalContentPath(current);
            this.store.database
                .prepare("UPDATE attachments SET state = ?, content_path = NULL, acknowledged_at = ?, storage_revision = storage_revision + 1 WHERE attachment_id = ?")
                .run(nextAttachmentState(String(current.state), "acknowledge"), now.toISOString(), attachmentId);
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
                if (contentPath !== null)
                    this.removeIfPresentSafely(contentPath);
            },
        });
    }
    expireDue(now = new Date()) {
        this.reconcileStagedFiles();
        let expired = 0;
        const rows = this.store.database
            .prepare("SELECT * FROM attachments WHERE expires_at <= ? AND state IN ('created', 'uploading', 'verified', 'delivered')")
            .all(now.toISOString());
        for (const row of rows) {
            let contentPath = null;
            this.store.transaction(() => {
                const current = this.getRow(String(row.attachment_id));
                if (Date.parse(String(current.expires_at)) > now.getTime() ||
                    !["created", "uploading", "verified", "delivered"].includes(String(current.state)))
                    return;
                contentPath = this.optionalContentPath(current);
                this.store.database
                    .prepare("UPDATE attachments SET state = ?, content_path = NULL, storage_revision = storage_revision + 1 WHERE attachment_id = ?")
                    .run(nextAttachmentState(String(current.state), "expire"), String(row.attachment_id));
                expired += 1;
            }, {
                onCommit: () => {
                    if (contentPath !== null)
                        this.removeIfPresentSafely(contentPath);
                },
            });
        }
        return expired;
    }
    cleanup() {
        let deletedFiles = 0;
        const pathsToDelete = new Set();
        this.store.transaction(() => {
            const protectedPaths = this.reconcileStagedFiles();
            const rows = this.store.database
                .prepare("SELECT attachment_id FROM attachments WHERE content_path IS NOT NULL AND state IN ('acknowledged', 'failed', 'expired')")
                .all();
            for (const row of rows) {
                const attachmentId = String(row.attachment_id);
                const current = this.getRow(attachmentId);
                const state = String(current.state);
                if (!cleanupStates.includes(state))
                    continue;
                const contentPath = this.optionalContentPath(current);
                if (contentPath === null)
                    continue;
                this.store.database
                    .prepare("UPDATE attachments SET state = ?, content_path = NULL, storage_revision = storage_revision + 1 WHERE attachment_id = ?")
                    .run(nextAttachmentState(state, "cleanup"), attachmentId);
                pathsToDelete.add(contentPath);
            }
            const referencedPaths = new Set(this.store.database
                .prepare("SELECT content_path FROM attachments WHERE content_path IS NOT NULL")
                .all()
                .map((row) => String(row.content_path)));
            for (const stagedPath of this.stagedPaths()) {
                if (!protectedPaths.has(stagedPath) && !referencedPaths.has(stagedPath)) {
                    pathsToDelete.add(stagedPath);
                }
            }
        }, {
            onCommit: () => {
                for (const path of pathsToDelete) {
                    if (this.removeIfPresentSafely(path))
                        deletedFiles += 1;
                }
            },
        });
        return deletedFiles;
    }
    countUnconfirmed(deviceId, pairingGeneration) {
        if (deviceId === undefined && pairingGeneration === undefined) {
            const row = this.store.database
                .prepare(`SELECT COUNT(*) AS count FROM attachments WHERE ${UNCONFIRMED_PREDICATE}`)
                .get();
            return row.count;
        }
        if (deviceId === undefined || pairingGeneration === undefined)
            throw new Error("SCHEMA_INVALID");
        const row = this.store.database
            .prepare(`SELECT COUNT(*) AS count FROM attachments WHERE ${UNCONFIRMED_PREDICATE} AND owner_device_id = :deviceId AND owner_pairing_generation = :pairingGeneration`)
            .get({ deviceId, pairingGeneration });
        return row.count;
    }
    /**
     * 解除配对: removes the target pairing's unconfirmed attachments and bytes.
     *
     * §13 makes this a resource-level transaction, not a per-attachment state
     * jump, so the rows themselves go — the bytes are already gone and the
     * contract removes the metadata with them (`:635`). The bytes are unlinked on
     * commit: removing them inside the transaction would leave a durable row
     * pointing at a file that no longer exists if the surrounding work rolls back.
     *
     * Rows from before device attribution was added remain unowned and are left
     * to TTL cleanup. Guessing an owner could destroy another device's bytes.
     */
    revokeUnconfirmed(input) {
        const now = input.now ?? new Date();
        const pathsToDelete = new Set();
        return this.store.transaction(() => {
            const rows = this.store.database
                .prepare(`SELECT * FROM attachments WHERE ${UNCONFIRMED_PREDICATE} AND owner_device_id = ? AND owner_pairing_generation = ?`)
                .all(input.deviceId, input.pairingGeneration);
            if (rows.length > 0) {
                this.store.database
                    .prepare("INSERT INTO account_metadata(key, value) VALUES ('attachment_delete_authorization', 'active') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                    .run();
            }
            for (const row of rows) {
                const contentPath = this.optionalContentPath(row);
                if (contentPath !== null)
                    pathsToDelete.add(contentPath);
                this.store.database
                    .prepare("DELETE FROM attachments WHERE attachment_id = ?")
                    .run(String(row.attachment_id));
            }
            if (rows.length > 0) {
                this.store.database.prepare("DELETE FROM account_metadata WHERE key = 'attachment_delete_authorization'").run();
                this.audit.append({
                    eventType: "attachment.revoked",
                    actor: { accountId: this.accountId, deviceId: input.deviceId },
                    subject: { scope: "unpair", pairingGeneration: input.pairingGeneration, revoked: rows.length },
                    correlationId: input.correlationId,
                    occurredAt: now.toISOString(),
                });
            }
            return rows.length;
        }, {
            onCommit: () => {
                for (const path of pathsToDelete)
                    this.removeIfPresentSafely(path);
            },
        });
    }
    get(attachmentId) {
        return this.mapRow(this.getRow(attachmentId));
    }
    requireVerifiedForMessage(attachmentId) {
        const record = this.get(attachmentId);
        if (record.state !== "verified")
            throw new Error("ATTACHMENT_EXPIRED");
    }
    openVerifiedStream(attachmentId) {
        const row = this.getRow(attachmentId);
        if (String(row.state) !== "verified")
            throw new Error("ATTACHMENT_EXPIRED");
        return decryptAttachmentStream(this.masterKey, this.accountId, attachmentId, this.requireContentPath(row));
    }
    async materializeVerified(attachmentId) {
        const path = join(this.paths.attachments, `${attachmentId}.${randomUUID()}.inbound`);
        const fd = openSync(path, "wx", 0o600);
        try {
            for await (const chunk of this.openVerifiedStream(attachmentId)) {
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
                    if (written <= 0)
                        throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
                    offset += written;
                }
            }
        }
        catch (error) {
            closeSync(fd);
            this.removeIfPresentSafely(path);
            throw error;
        }
        closeSync(fd);
        return Object.freeze({ path, cleanup: () => { this.removeIfPresentSafely(path); } });
    }
    transition(attachmentId, event, timestampColumn, now) {
        return this.store.transaction(() => {
            const current = this.getRow(attachmentId);
            this.store.database
                .prepare(`UPDATE attachments SET state = ?, ${timestampColumn} = ?, storage_revision = storage_revision + 1 WHERE attachment_id = ?`)
                .run(nextAttachmentState(String(current.state), event), now.toISOString(), attachmentId);
            return this.get(attachmentId);
        });
    }
    contentPath(attachmentId) {
        return join(this.paths.attachments, `${attachmentId}.stage`);
    }
    async migrateLegacyStagesAsync() {
        const paths = this.stagedPaths();
        if (paths.length === 0)
            return;
        for (const path of paths) {
            const fd = openSync(path, "r");
            const prefix = Buffer.alloc(8);
            try {
                readSync(fd, prefix, 0, prefix.byteLength, 0);
            }
            finally {
                closeSync(fd);
            }
            const attachmentId = path.slice(this.paths.attachments.length + 1, -".stage".length);
            const row = this.store.database
                .prepare("SELECT state, content_path, size_bytes, sha256, uploaded_size_bytes, uploaded_sha256 FROM attachments WHERE attachment_id = ?")
                .get(attachmentId);
            const encryptedStream = prefix.toString("ascii") === "OAIEAV1\n";
            if (row === undefined) {
                if (!this.removeIfPresentSafely(path))
                    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
                continue;
            }
            if (!encryptedStream && row.content_path !== path) {
                if (!this.removeIfPresentSafely(path))
                    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
                continue;
            }
            if (encryptedStream) {
                if (row.uploaded_size_bytes !== null && row.uploaded_sha256 !== null)
                    continue;
                if (this.masterKey === undefined || this.masterKey.byteLength !== 32)
                    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
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
                        .prepare("UPDATE attachments SET uploaded_size_bytes = ?, uploaded_sha256 = ?, storage_revision = storage_revision + 1 WHERE attachment_id = ?")
                        .run(sizeBytes, sha256, attachmentId);
                });
                continue;
            }
            // Legacy OpenClaw stages were plaintext. Do not replace a file in place:
            // an older host could then read OAIEAV1 bytes as if they were plaintext.
            // Remove the old row transactionally so a retry with the same
            // clientAttachmentId can create a fresh streaming attachment. The file
            // is removed only after that DB decision commits.
            this.store.transaction(() => {
                this.audit.append({
                    eventType: "attachment.legacy_format.requires_reupload",
                    actor: { accountId: this.accountId },
                    subject: { attachmentId, format: "plaintext-stage" },
                    correlationId: `legacy-stage-drain:${attachmentId}`,
                    occurredAt: new Date().toISOString(),
                });
                this.withAttachmentDeleteAuthorization(() => {
                    this.store.database.prepare("DELETE FROM attachments WHERE attachment_id = ?").run(attachmentId);
                });
            }, {
                onCommit: () => this.removeIfPresentSafely(path),
            });
        }
    }
    withAttachmentDeleteAuthorization(work) {
        this.store.database
            .prepare("INSERT INTO account_metadata(key, value) VALUES ('attachment_delete_authorization', 'active') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run();
        try {
            return work();
        }
        finally {
            this.store.database.prepare("DELETE FROM account_metadata WHERE key = 'attachment_delete_authorization'").run();
        }
    }
    stagedPaths() {
        try {
            return readdirSync(this.paths.attachments, { withFileTypes: true })
                .filter((entry) => entry.isFile() && entry.name.endsWith(".stage"))
                .map((entry) => join(this.paths.attachments, entry.name));
        }
        catch {
            return [];
        }
    }
    reconcileStagedFiles() {
        const protectedPaths = new Set();
        for (const stagedPath of this.stagedPaths()) {
            const suffix = ".stage";
            const fileName = stagedPath.slice(this.paths.attachments.length + 1);
            const attachmentId = fileName.slice(0, -suffix.length);
            if (this.reconcileStagedFile(attachmentId, "startup"))
                protectedPaths.add(stagedPath);
        }
        return protectedPaths;
    }
    reconcileStagedFile(attachmentId, reason) {
        const stagedPath = this.contentPath(attachmentId);
        if (!existsSync(stagedPath))
            return false;
        let repaired = false;
        try {
            this.store.transaction(() => {
                const row = this.store.database
                    .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
                    .get(attachmentId);
                if (row === undefined)
                    return;
                const state = String(row.state);
                if (!stageRecoverableStates.includes(state))
                    return;
                const currentPath = this.optionalContentPath(row);
                const nextState = state === "created" ? "uploading" : state;
                if (currentPath === stagedPath && nextState === state)
                    return;
                this.store.database
                    .prepare("UPDATE attachments SET state = ?, content_path = ?, storage_revision = storage_revision + 1 WHERE attachment_id = ?")
                    .run(nextState, stagedPath, attachmentId);
                repaired = true;
            });
        }
        catch {
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
            }
            catch {
                // Reconciliation metadata is best effort; the row and stage path are durable.
            }
        }
        return false;
    }
    getRow(attachmentId) {
        const row = this.store.database
            .prepare("SELECT * FROM attachments WHERE attachment_id = ?")
            .get(attachmentId);
        if (row === undefined)
            throw new Error("ATTACHMENT_EXPIRED");
        return row;
    }
    mapRow(row) {
        const contentPath = this.optionalContentPath(row);
        return Object.freeze({
            attachmentId: String(row.attachment_id),
            state: String(row.state),
            filename: String(row.filename),
            mediaType: String(row.media_type),
            sizeBytes: Number(row.size_bytes),
            sha256: String(row.sha256),
            hasStagedBytes: contentPath !== null && existsSync(contentPath),
            expiresAt: String(row.expires_at),
        });
    }
    optionalContentPath(row) {
        return typeof row.content_path === "string" && row.content_path.length > 0
            ? row.content_path
            : null;
    }
    requireContentPath(row) {
        const contentPath = this.optionalContentPath(row);
        if (contentPath === null || !existsSync(contentPath))
            throw new Error("ATTACHMENT_EXPIRED");
        return contentPath;
    }
    removeIfPresent(path) {
        if (!existsSync(path))
            return false;
        unlinkSync(path);
        return true;
    }
    removeIfPresentSafely(path) {
        try {
            return this.removeIfPresent(path);
        }
        catch {
            // The DB no longer references this path; the orphan scan can retry cleanup.
            return false;
        }
    }
}
