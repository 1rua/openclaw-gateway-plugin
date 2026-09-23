import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const fsyncControl = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/core/attachment-crypto.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/attachment-crypto.js")>();
  return {
    ...original,
    fsyncAttachmentDirectory: (path: string): void => {
      if (fsyncControl.fail) throw new Error("EIO injected directory fsync failure");
      original.fsyncAttachmentDirectory(path);
    },
  };
});

import { createGatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-storage-failure-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("OpenClaw attachment storage failure recovery", () => {
  it("never verifies after directory fsync fails and recovers the complete encrypted file on reopen", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x39) });
    const account = await core.openGatewayAccount("acct_fsync_failure");
    const bytes = Buffer.from("durable attachment");
    const attachment = account.attachments.create({
      clientAttachmentId: "client_fsync_failure",
      filename: "fsync.bin",
      mediaType: "application/x-fsync",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_fsync_failure",
    });
    fsyncControl.fail = true;
    await expect(account.attachments.uploadContent(attachment.attachmentId, bytes))
      .rejects.toThrow("ATTACHMENT_STORAGE_UNAVAILABLE");
    expect(account.attachments.get(attachment.attachmentId).state).toBe("created");
    const stagePath = join(account.paths.attachments, `${attachment.attachmentId}.stage`);
    expect(existsSync(stagePath)).toBe(true);
    fsyncControl.fail = false;
    account.close();

    const recovered = await core.openGatewayAccount("acct_fsync_failure");
    expect(recovered.attachments.get(attachment.attachmentId).state).toBe("uploading");
    expect(recovered.attachments.commit(attachment.attachmentId).state).toBe("verified");
    recovered.close();
  });

  it("does not leave an attachment verified when rename fails", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x39) });
    const account = await core.openGatewayAccount("acct_rename_failure");
    const bytes = Buffer.from("rename failure");
    const attachment = account.attachments.create({
      clientAttachmentId: "client_rename_failure",
      filename: "rename.bin",
      mediaType: "application/x-rename",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      correlationId: "cor_rename_failure",
    });
    mkdirSync(join(account.paths.attachments, `${attachment.attachmentId}.stage`));
    await expect(account.attachments.uploadContent(attachment.attachmentId, bytes))
      .rejects.toThrow("ATTACHMENT_STORAGE_UNAVAILABLE");
    expect(account.attachments.get(attachment.attachmentId).state).toBe("created");
    account.close();
  });
});
