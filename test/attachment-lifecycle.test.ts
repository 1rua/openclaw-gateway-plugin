import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
});
