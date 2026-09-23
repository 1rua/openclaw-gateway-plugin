import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTACHMENT_MASTER_KEY_FILE_ENV } from "../src/core/attachment-master-key.js";
import { createGatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-key-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("OpenClaw attachment master key source", () => {
  it("fails closed when the key material changes at the same configured path", async () => {
    const storageRoot = tempRoot();
    const keyPath = join(tempRoot(), "attachment.key");
    writeFileSync(keyPath, Buffer.alloc(32, 0x19), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const previous = process.env[ATTACHMENT_MASTER_KEY_FILE_ENV];
    process.env[ATTACHMENT_MASTER_KEY_FILE_ENV] = keyPath;
    try {
      const initialCore = createGatewayCore({ storageRoot });
      const account = await initialCore.openGatewayAccount("acct_key_rotation");
      const bytes = Buffer.from("encrypted before key change");
      const attachment = account.attachments.create({
        clientAttachmentId: "client_key_rotation",
        filename: "file.dat",
        mediaType: "application/x-key-check",
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        correlationId: "cor_key_rotation",
      });
      await account.attachments.uploadContent(attachment.attachmentId, bytes);
      account.close();

      writeFileSync(keyPath, Buffer.alloc(32, 0x28), { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const rotatedCore = createGatewayCore({ storageRoot });
      await expect(rotatedCore.openGatewayAccount("acct_key_rotation"))
        .rejects.toThrow("ATTACHMENT_STORAGE_UNAVAILABLE");
    } finally {
      if (previous === undefined) delete process.env[ATTACHMENT_MASTER_KEY_FILE_ENV];
      else process.env[ATTACHMENT_MASTER_KEY_FILE_ENV] = previous;
    }
  });
});
