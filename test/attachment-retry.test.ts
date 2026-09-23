import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";
import { accountPaths } from "../src/core/account-paths.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-attachment-retry-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("OpenClaw attachment unknown-outcome recovery", () => {
  it("fences attachment writes from an older host that cannot bind the active pairing", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x6a) });
    const account = await core.openGatewayAccount("acct_attachment_format_fence");
    try {
      expect(() => account.store.database.prepare(`
        INSERT INTO attachments(
          attachment_id, client_attachment_id, client_attachment_key, filename, media_type,
          size_bytes, sha256, state, content_path, uploaded_size_bytes, uploaded_sha256,
          created_at, expires_at, delivered_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "att_old_writer", "old_writer", null, "legacy.bin", "application/octet-stream",
        0, "0".repeat(64), "created", null, null, null,
        "2026-09-23T00:00:00.000Z", "2026-09-24T00:00:00.000Z", null, null,
      )).toThrow(/ATTACHMENT_PAIRING_BINDING_REQUIRED/);
    } finally {
      account.close();
    }
  });

  it("fails closed when the account store is marked with a newer attachment format", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x6a) });
    const account = await core.openGatewayAccount("acct_attachment_unknown_format");
    account.store.database.prepare("UPDATE account_metadata SET value = '3' WHERE key = 'attachment_storage_format'").run();
    account.close();

    await expect(core.openGatewayAccount("acct_attachment_unknown_format"))
      .rejects.toThrow("ATTACHMENT_STORAGE_VERSION_UNSUPPORTED");
  });

  it("reuses clientAttachmentId, makes repeated PUT/commit idempotent and exposes protocol status", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x6a) });
    const account = await core.openGatewayAccount("acct_attachment_retry");
    const bytes = Buffer.from("uploaded exactly once");
    const metadata = {
      clientAttachmentId: "stable-client-attachment-id",
      filename: "retry.bin",
      mediaType: "application/x-any-type",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_first_create",
    };
    const first = account.attachments.create(metadata);
    const replay = account.attachments.create({ ...metadata, correlationId: "cor_retry_create" });
    expect(replay.attachmentId).toBe(first.attachmentId);
    expect(() => account.attachments.create({ ...metadata, filename: "different.bin" }))
      .toThrow("IDEMPOTENCY_CONFLICT");

    await account.attachments.uploadContent(first.attachmentId, bytes);
    const commitRequest = (requestId: string) => core.handle({
      context: {
        accountId: "acct_attachment_retry",
        deviceId: "device_retry",
        sessionId: "session_retry",
        requestId,
        correlationId: `cor_${requestId}`,
        pairingGeneration: 1,
        grantRevision: 1,
      },
      method: "POST",
      target: `/open-android-intelligence/v2/attachments/${first.attachmentId}/commit`,
      idempotencyKey: requestId,
    });
    await expect(commitRequest("request_commit_attachment")).resolves.toMatchObject({
      data: { attachment: { attachmentId: first.attachmentId, status: "uploaded", sizeBytes: bytes.byteLength } },
    });
    const storedPath = join(account.paths.attachments, `${first.attachmentId}.stage`);
    const ciphertext = readFileSync(storedPath);
    await account.attachments.uploadContentStream(first.attachmentId, (async function* () { yield bytes; })(), {
      contentLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
    await expect(commitRequest("request_commit_attachment_retry")).resolves.toMatchObject({
      data: { attachment: { attachmentId: first.attachmentId, status: "uploaded" } },
    });
    expect(readFileSync(storedPath).equals(ciphertext)).toBe(true);

    const status = await core.handle({
      context: {
        accountId: "acct_attachment_retry",
        deviceId: "device_retry",
        sessionId: "session_retry",
        requestId: "request_attachment_status",
        correlationId: "cor_attachment_status",
        pairingGeneration: 1,
        grantRevision: 1,
      },
      method: "GET",
      target: `/open-android-intelligence/v2/attachments/${first.attachmentId}`,
    });
    expect(status).toMatchObject({
      protocol: "2.1",
      data: { attachment: { attachmentId: first.attachmentId, status: "uploaded", sizeBytes: bytes.byteLength, sha256: sha256(bytes) } },
    });
    expect(JSON.stringify(status)).not.toContain('"state"');
    account.close();
  });

  it("rolls back interrupted legacy duplicate-id migration, recovers, then enforces new idempotency", async () => {
    const storageRoot = tempRoot();
    const paths = accountPaths(storageRoot, "acct_legacy_duplicates");
    mkdirSync(paths.root, { recursive: true });
    const legacy = new DatabaseSync(paths.database);
    legacy.exec(`
      CREATE TABLE attachments (
        attachment_id TEXT PRIMARY KEY NOT NULL,
        client_attachment_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        state TEXT NOT NULL,
        content_path TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT
      );
      INSERT INTO attachments VALUES
        ('att_old_1', 'old-content-id', 'old-1.bin', 'application/x-old', 1, '${"a".repeat(64)}', 'expired', NULL, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', NULL, NULL),
        ('att_old_2', 'old-content-id', 'old-2.bin', 'application/x-old', 1, '${"b".repeat(64)}', 'expired', NULL, '2026-09-01T00:00:01.000Z', '2026-09-02T00:00:00.000Z', NULL, NULL);
    `);
    legacy.close();

    const core = createGatewayCore({ storageRoot, attachmentMasterKey: Buffer.alloc(32, 0x6a) });
    const migrationFailure = new DatabaseSync(paths.database);
    migrationFailure.exec(`
      CREATE TRIGGER fail_client_key_migration
      BEFORE UPDATE OF client_attachment_key ON attachments
      BEGIN SELECT RAISE(ABORT, 'forced client key migration interruption'); END;
    `);
    migrationFailure.close();
    await expect(core.openGatewayAccount("acct_legacy_duplicates"))
      .rejects.toThrow("forced client key migration interruption");
    const verifyRollback = new DatabaseSync(paths.database);
    const keysAfterRollback = verifyRollback.prepare("SELECT client_attachment_key FROM attachments ORDER BY attachment_id")
      .all() as Array<{ client_attachment_key: string | null }>;
    expect(keysAfterRollback).toEqual([{ client_attachment_key: null }, { client_attachment_key: null }]);
    verifyRollback.exec("DROP TRIGGER fail_client_key_migration");
    verifyRollback.close();

    const account = await core.openGatewayAccount("acct_legacy_duplicates");
    expect(account.attachments.get("att_old_1").state).toBe("expired");
    expect(account.attachments.get("att_old_2").state).toBe("expired");
    const metadata = {
      clientAttachmentId: "old-content-id",
      filename: "new.bin",
      mediaType: "application/x-new",
      sizeBytes: 0,
      sha256: sha256(new Uint8Array()),
      correlationId: "cor_new_after_legacy",
    };
    const first = account.attachments.create(metadata);
    const retry = account.attachments.create({ ...metadata, correlationId: "cor_retry_after_legacy" });
    expect(retry.attachmentId).toBe(first.attachmentId);
    const rows = account.store.database.prepare(`
      SELECT client_attachment_id, client_attachment_key FROM attachments
      WHERE attachment_id IN ('att_old_1', 'att_old_2') ORDER BY attachment_id
    `).all() as Array<{ client_attachment_id: string; client_attachment_key: string }>;
    expect(rows).toEqual([
      { client_attachment_id: "old-content-id", client_attachment_key: "legacy:att_old_1" },
      { client_attachment_id: "old-content-id", client_attachment_key: "legacy:att_old_2" },
    ]);
    account.close();
    const reopened = await core.openGatewayAccount("acct_legacy_duplicates");
    expect(reopened.attachments.create({ ...metadata, correlationId: "cor_retry_after_restart" }).attachmentId)
      .toBe(first.attachmentId);
    reopened.close();
  });
});
