import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-streamed-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const masterKey = (): Buffer => Buffer.alloc(32, 0x7c);

async function* bytesInChunks(bytes: Uint8Array, chunkSize = 37_111): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
  }
}

describe("OpenClaw encrypted streaming attachments", () => {
  it("accepts arbitrary MIME facts and streams attachments above the old limits into encrypted account storage", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: masterKey() });
    const account = await core.openGatewayAccount("acct_alice");
    const length = 25 * 1024 * 1024 + 8193;
    async function* generated(hash?: ReturnType<typeof createHash>): AsyncGenerator<Uint8Array> {
      let remaining = length;
      let seed = 0;
      while (remaining > 0) {
        const size = Math.min(64 * 1024, remaining);
        const chunk = Buffer.alloc(size);
        chunk.fill(seed++ & 0xff);
        hash?.update(chunk);
        remaining -= size;
        yield chunk;
      }
    }

    const expectedDigest = createHash("sha256");
    for await (const chunk of generated(expectedDigest)) { /* bounded streaming hash pass */ }
    const digest = expectedDigest.digest("hex");
    const attachment = account.attachments.create({
      clientAttachmentId: "att_unbounded",
      filename: "unsupported-by-old-allowlist.bin",
      mediaType: "application/x-agent-defined",
      sizeBytes: length,
      sha256: digest,
      correlationId: "cor_streamed",
    });
    await account.attachments.uploadContentStream(
      attachment.attachmentId,
      generated(),
      { contentLength: length, sha256: digest },
    );
    const verified = account.attachments.commit(attachment.attachmentId);
    expect(verified).toMatchObject({ state: "verified", mediaType: "application/x-agent-defined", sizeBytes: length });

    const storedPath = join(account.paths.attachments, `${attachment.attachmentId}.stage`);
    expect(existsSync(storedPath)).toBe(true);
    const encrypted = readFileSync(storedPath);
    expect(encrypted.subarray(0, 8).toString("ascii")).toBe("OAIEAV1\n");
    expect(encrypted.includes(Buffer.from("unsupported-by-old-allowlist"))).toBe(false);

    const reopened = await core.openGatewayAccount("acct_alice");
    const opened = reopened.attachments.openVerifiedStream(attachment.attachmentId);
    const openedDigest = createHash("sha256");
    let openedLength = 0;
    for await (const chunk of opened) {
      openedDigest.update(chunk);
      openedLength += chunk.byteLength;
    }
    expect(openedLength).toBe(length);
    expect(openedDigest.digest("hex")).toBe(digest);
    reopened.close();
    account.close();
  });

  it("rejects truncation or an actual Digest mismatch before an attachment can be committed", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: masterKey() });
    const account = await core.openGatewayAccount("acct_alice");
    const bytes = new TextEncoder().encode("actual bytes");
    const attachment = account.attachments.create({
      clientAttachmentId: "att_wrong_digest",
      filename: "payload.unknown",
      mediaType: "application/x-anything",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_wrong_digest",
    });

    await expect(account.attachments.uploadContentStream(
      attachment.attachmentId,
      bytesInChunks(bytes),
      { contentLength: bytes.byteLength, sha256: "0".repeat(64) },
    )).rejects.toThrow("ATTACHMENT_DIGEST_MISMATCH");
    expect(() => account.attachments.commit(attachment.attachmentId)).toThrow("ATTACHMENT_EXPIRED");
    account.close();
  });

  it("detects cross-account ciphertext moves, chunk reordering and truncated encrypted records", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: masterKey() });
    const alice = await core.openGatewayAccount("acct_alice");
    const bob = await core.openGatewayAccount("acct_bob");
    const bytes = Buffer.alloc(150_000, 0x61);
    const makeVerified = async (account: typeof alice, clientId: string) => {
      const record = account.attachments.create({
        clientAttachmentId: clientId,
        filename: `${clientId}.bin`,
        mediaType: "application/x-any",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        correlationId: clientId,
      });
      await account.attachments.uploadContent(record.attachmentId, bytes);
      account.attachments.commit(record.attachmentId);
      return record;
    };
    const aliceAttachment = await makeVerified(alice, "alice_copy");
    const bobAttachment = await makeVerified(bob, "bob_copy");
    const alicePath = join(alice.paths.attachments, `${aliceAttachment.attachmentId}.stage`);
    const bobPath = join(bob.paths.attachments, `${bobAttachment.attachmentId}.stage`);
    const bobCiphertext = readFileSync(bobPath);
    const aliceCiphertext = readFileSync(alicePath);

    const expectDecryptFailure = async (): Promise<void> => {
      await expect(async () => {
        for await (const _chunk of bob.attachments.openVerifiedStream(bobAttachment.attachmentId)) { /* consume to authenticate every chunk */ }
      }).rejects.toThrow("ATTACHMENT_READ_FAILED");
    };
    writeFileSync(bobPath, aliceCiphertext);
    await expectDecryptFailure();

    const frames: Buffer[] = [];
    let offset = 8;
    for (let index = 0; index < Math.ceil(bytes.byteLength / 64 / 1024); index += 1) {
      const length = bobCiphertext.readUInt32BE(offset + 4);
      const frameLength = 20 + length + 16;
      frames.push(bobCiphertext.subarray(offset, offset + frameLength));
      offset += frameLength;
    }
    expect(frames.length).toBeGreaterThan(1);
    const footer = bobCiphertext.subarray(offset);
    expect(footer.byteLength).toBe(80);
    const reordered = Buffer.concat([bobCiphertext.subarray(0, 8), frames[1]!, frames[0]!, ...frames.slice(2), footer]);
    writeFileSync(bobPath, reordered);
    await expectDecryptFailure();

    const replayed = Buffer.concat([bobCiphertext.subarray(0, 8), frames[0]!, frames[0]!, ...frames.slice(1), footer]);
    writeFileSync(bobPath, replayed);
    await expectDecryptFailure();

    writeFileSync(bobPath, Buffer.concat([bobCiphertext.subarray(0, 8), ...frames.slice(0, -1), footer]));
    await expectDecryptFailure();

    writeFileSync(bobPath, bobCiphertext.subarray(0, bobCiphertext.byteLength - footer.byteLength));
    await expectDecryptFailure();

    writeFileSync(bobPath, bobCiphertext.subarray(0, bobCiphertext.byteLength - 3));
    await expectDecryptFailure();
    alice.close();
    bob.close();
  });

  it("recovers a legacy migration interrupted after atomic ciphertext replacement", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot, attachmentMasterKey: masterKey() });
    const account = await core.openGatewayAccount("acct_migrate");
    const bytes = Buffer.from("legacy plaintext attachment");
    const attachment = account.attachments.create({
      clientAttachmentId: "client_legacy",
      filename: "legacy.bin",
      mediaType: "application/x-legacy",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_legacy",
    });
    const stagePath = join(account.paths.attachments, `${attachment.attachmentId}.stage`);
    writeFileSync(stagePath, bytes, { mode: 0o600 });
    account.store.database.prepare("UPDATE attachments SET state = 'uploading', content_path = ? WHERE attachment_id = ?")
      .run(stagePath, attachment.attachmentId);
    account.store.database.exec(`
      CREATE TRIGGER fail_legacy_metadata_update
      BEFORE UPDATE OF uploaded_size_bytes ON attachments
      BEGIN SELECT RAISE(ABORT, 'forced migration metadata failure'); END;
    `);
    account.close();

    await expect(core.openGatewayAccount("acct_migrate")).rejects.toThrow("forced migration metadata failure");
    expect(readFileSync(stagePath).subarray(0, 8).toString("ascii")).toBe("OAIEAV1\n");

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(account.paths.root, "gateway.sqlite"));
    database.exec("DROP TRIGGER fail_legacy_metadata_update");
    database.close();

    const recovered = await core.openGatewayAccount("acct_migrate");
    expect(recovered.attachments.get(attachment.attachmentId).state).toBe("uploading");
    expect(recovered.attachments.commit(attachment.attachmentId).state).toBe("verified");
    const recoveredBytes: Buffer[] = [];
    for await (const chunk of recovered.attachments.openVerifiedStream(attachment.attachmentId)) recoveredBytes.push(chunk);
    expect(Buffer.concat(recoveredBytes).equals(bytes)).toBe(true);
    recovered.close();
  });

  it("does not mark a file verified when a complete encrypted tail chunk is removed before commit", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: masterKey() });
    const account = await core.openGatewayAccount("acct_commit_tamper");
    const bytes = Buffer.alloc(150_000, 0x72);
    const attachment = account.attachments.create({
      clientAttachmentId: "client_commit_tamper",
      filename: "tail.bin",
      mediaType: "application/x-tail",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_commit_tamper",
    });
    await account.attachments.uploadContent(attachment.attachmentId, bytes);
    const stagePath = join(account.paths.attachments, `${attachment.attachmentId}.stage`);
    const ciphertext = readFileSync(stagePath);
    const frames: Buffer[] = [];
    let offset = 8;
    for (let index = 0; index < 3; index += 1) {
      const length = ciphertext.readUInt32BE(offset + 4);
      const recordLength = 20 + length + 16;
      frames.push(ciphertext.subarray(offset, offset + recordLength));
      offset += recordLength;
    }
    writeFileSync(stagePath, Buffer.concat([ciphertext.subarray(0, 8), ...frames.slice(0, -1)]));
    expect(() => account.attachments.commit(attachment.attachmentId)).toThrow("ATTACHMENT_READ_FAILED");
    expect(account.attachments.get(attachment.attachmentId).state).toBe("failed");
    account.close();
  });
});
