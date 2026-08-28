import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "agent-life-openclaw-attachment-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("OpenClaw Gateway attachment lifecycle", () => {
  it("keeps staged bytes account-local and removes them on ACK and TTL expiry", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const alice = await core.openGatewayAccount("acct_alice");
    const bob = await core.openGatewayAccount("acct_bob");
    const body = new TextEncoder().encode("short lived content");

    const attachment = alice.attachments.create({
      clientAttachmentId: "att_client_1",
      filename: "note.txt",
      mediaType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      correlationId: "cor_attachment",
    });
    alice.attachments.uploadContent(attachment.attachmentId, body);
    const verified = alice.attachments.commit(attachment.attachmentId);

    expect(verified.state).toBe("verified");
    expect(verified.hasStagedBytes).toBe(true);
    expect(() => bob.attachments.get(attachment.attachmentId)).toThrowError("ATTACHMENT_EXPIRED");

    alice.attachments.markDelivered(attachment.attachmentId);
    const acknowledged = alice.attachments.acknowledge(attachment.attachmentId, "cor_ack");
    expect(acknowledged.state).toBe("acknowledged");
    expect(acknowledged.hasStagedBytes).toBe(false);

    const expired = alice.attachments.create({
      clientAttachmentId: "att_client_2",
      filename: "ttl.txt",
      mediaType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      correlationId: "cor_ttl",
      expiresAt: "2026-08-24T00:00:00.000Z",
    });
    alice.attachments.uploadContent(expired.attachmentId, body);
    alice.attachments.expireDue(new Date("2026-08-24T00:00:01.000Z"));
    const expiredStatus = alice.attachments.get(expired.attachmentId);
    expect(expiredStatus.state).toBe("expired");
    expect(expiredStatus.hasStagedBytes).toBe(false);

    alice.close();
    bob.close();
  });

  it("keeps a rolled-back handle upload discoverable and TTL-cleanable", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    const body = new TextEncoder().encode("upload must remain auditable");
    const attachment = account.attachments.create({
      clientAttachmentId: "att_upload_rollback",
      filename: "upload.txt",
      mediaType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      correlationId: "cor_upload_rollback",
      expiresAt: "2026-08-27T00:10:00.000Z",
    });
    account.store.database.exec(`
      CREATE TRIGGER fail_upload_ledger
      BEFORE INSERT ON idempotency_ledger
      BEGIN
        SELECT RAISE(ABORT, 'upload ledger forced failure');
      END;
    `);
    account.close();

    await expect(core.handle({
      context: {
        accountId: "acct_alice",
        deviceId: "dev_1",
        sessionId: "sess_upload_rollback",
        requestId: "req_upload_rollback",
        correlationId: "cor_upload_rollback_handle",
        pairingGeneration: 1,
        grantRevision: 1,
      },
      method: "PUT",
      target: `/agent-life/v2/attachments/${attachment.attachmentId}/content`,
      idempotencyKey: "req_upload_rollback",
      body,
      now: new Date("2026-08-27T00:00:01.000Z"),
    })).resolves.toMatchObject({ error: { code: "INTERNAL_ERROR" } });

    const reopened = await core.openGatewayAccount("acct_alice");
    const row = reopened.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    const expectedPath = join(reopened.paths.attachments, `${attachment.attachmentId}.stage`);
    expect(row.state).toBe("uploading");
    expect(row.content_path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(reopened.attachments.get(attachment.attachmentId)).toMatchObject({
      state: "uploading",
      hasStagedBytes: true,
    });

    expect(reopened.attachments.expireDue(new Date("2026-08-27T00:10:01.000Z"))).toBe(1);
    const cleaned = reopened.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    expect(cleaned.state).toBe("expired");
    expect(cleaned.content_path).toBeNull();
    expect(existsSync(expectedPath)).toBe(false);
    reopened.close();
  });

  it("keeps the unique staged file when digest-failure commit rolls back and lets TTL clean it", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    const body = new TextEncoder().encode("digest failure body");
    const attachment = account.attachments.create({
      clientAttachmentId: "att_digest_rollback",
      filename: "digest.txt",
      mediaType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(new TextEncoder().encode("different digest")),
      correlationId: "cor_digest_rollback",
      expiresAt: "2026-08-27T00:20:00.000Z",
    });
    account.attachments.uploadContent(attachment.attachmentId, body);
    account.store.database.exec(`
      CREATE TRIGGER fail_digest_ledger
      BEFORE INSERT ON idempotency_ledger
      BEGIN
        SELECT RAISE(ABORT, 'digest ledger forced failure');
      END;
    `);
    account.close();

    await expect(core.handle({
      context: {
        accountId: "acct_alice",
        deviceId: "dev_1",
        sessionId: "sess_digest_rollback",
        requestId: "req_digest_rollback",
        correlationId: "cor_digest_rollback_handle",
        pairingGeneration: 1,
        grantRevision: 1,
      },
      method: "POST",
      target: `/agent-life/v2/attachments/${attachment.attachmentId}/commit`,
      idempotencyKey: "req_digest_rollback",
      now: new Date("2026-08-27T00:00:01.000Z"),
    })).resolves.toMatchObject({ error: { code: "INTERNAL_ERROR" } });

    const reopened = await core.openGatewayAccount("acct_alice");
    const row = reopened.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    const expectedPath = join(reopened.paths.attachments, `${attachment.attachmentId}.stage`);
    expect(row.state).toBe("uploading");
    expect(row.content_path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(reopened.attachments.get(attachment.attachmentId)).toMatchObject({
      state: "uploading",
      hasStagedBytes: true,
    });

    expect(reopened.attachments.expireDue(new Date("2026-08-27T00:20:01.000Z"))).toBe(1);
    const cleaned = reopened.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    expect(cleaned.state).toBe("expired");
    expect(cleaned.content_path).toBeNull();
    expect(existsSync(expectedPath)).toBe(false);
    reopened.close();
  });

  it("keeps a digest-failed attachment referenceable until explicit cleanup", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    const body = new TextEncoder().encode("digest failure must be cleaned");
    const attachment = account.attachments.create({
      clientAttachmentId: "att_digest_cleanup",
      filename: "digest-cleanup.txt",
      mediaType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(new TextEncoder().encode("not the uploaded bytes")),
      correlationId: "cor_digest_cleanup",
      expiresAt: "2026-08-27T00:30:00.000Z",
    });
    account.attachments.uploadContent(attachment.attachmentId, body);
    account.close();

    const response = await core.handle({
      context: {
        accountId: "acct_alice",
        deviceId: "dev_1",
        sessionId: "sess_digest_cleanup",
        requestId: "req_digest_cleanup",
        correlationId: "cor_digest_cleanup_handle",
        pairingGeneration: 1,
        grantRevision: 1,
      },
      method: "POST",
      target: `/agent-life/v2/attachments/${attachment.attachmentId}/commit`,
      idempotencyKey: "req_digest_cleanup",
      now: new Date("2026-08-27T00:00:01.000Z"),
    });
    expect(response).toMatchObject({ error: { code: "ATTACHMENT_DIGEST_MISMATCH" } });

    const reopened = await core.openGatewayAccount("acct_alice");
    const row = reopened.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    const expectedPath = join(reopened.paths.attachments, `${attachment.attachmentId}.stage`);
    expect(row.state).toBe("failed");
    expect(row.content_path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    expect(reopened.attachments.cleanup()).toBe(1);
    const cleaned = reopened.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    expect(cleaned.state).toBe("deleted");
    expect(cleaned.content_path).toBeNull();
    expect(existsSync(expectedPath)).toBe(false);
    reopened.close();
  });

  it("protects a recoverable staged file when reconciliation fails and retries on the next scan", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    const body = new TextEncoder().encode("reconciliation must fail closed");
    const attachment = account.attachments.create({
      clientAttachmentId: "att_reconcile_protected",
      filename: "reconcile.txt",
      mediaType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      correlationId: "cor_reconcile_protected",
      expiresAt: "2030-01-01T00:10:00.000Z",
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    const stagedPath = join(account.paths.attachments, `${attachment.attachmentId}.stage`);
    writeFileSync(stagedPath, body, { mode: 0o600 });
    account.store.database.exec(`
      CREATE TRIGGER fail_reconcile_repair
      BEFORE UPDATE OF state, content_path ON attachments
      WHEN OLD.attachment_id = '${attachment.attachmentId}'
        AND OLD.content_path IS NULL
        AND NEW.content_path IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'reconciliation forced failure');
      END;
    `);

    expect(account.attachments.cleanup()).toBe(0);
    expect(existsSync(stagedPath)).toBe(true);
    const unrepaired = account.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    expect(unrepaired.state).toBe("created");
    expect(unrepaired.content_path).toBeNull();

    account.store.database.exec("DROP TRIGGER fail_reconcile_repair");
    expect(account.attachments.cleanup()).toBe(0);
    const repaired = account.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    expect(repaired.state).toBe("uploading");
    expect(repaired.content_path).toBe(stagedPath);
    expect(existsSync(stagedPath)).toBe(true);

    expect(account.attachments.expireDue(new Date("2030-01-01T00:10:01.000Z"))).toBe(1);
    const expired = account.store.database
      .prepare("SELECT state, content_path FROM attachments WHERE attachment_id = ?")
      .get(attachment.attachmentId) as { state: string; content_path: string | null };
    expect(expired.state).toBe("expired");
    expect(expired.content_path).toBeNull();
    expect(existsSync(stagedPath)).toBe(false);
    account.close();
  });

  it("reports the number of orphan stage files actually deleted", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const account = await core.openGatewayAccount("acct_alice");
    const orphanPath = join(account.paths.attachments, "att_orphan_round3.stage");
    writeFileSync(orphanPath, new TextEncoder().encode("orphan"), { mode: 0o600 });

    expect(account.attachments.cleanup()).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
    account.close();
  });
});
