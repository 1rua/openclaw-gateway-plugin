import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GatewayBackupService } from "../src/core/backup-service.js";
import { createGatewayCore } from "../src/core/gateway-core.js";
import { IdentityRotationService } from "../src/core/identity-rotation.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "agent-life-openclaw-backup-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("OpenClaw Gateway backup and identity rotation", () => {
  it("exports only portable account state and rotates identity without changing the account master key reference", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const alice = await core.openGatewayAccount("acct_alice");
    const initialMasterKeyRef = alice.masterKeyRef;

    const session = alice.sessions.createPasswordSession({
      username: "alice",
      password: "backup password",
      installation: {
        installationId: "install_backup",
        displayName: "Alice phone",
        devicePublicKey: "AliceDevicePublicKey",
      },
      correlationId: "cor_login",
    });
    const body = new TextEncoder().encode("backup must not contain this staged body");
    const attachment = alice.attachments.create({
      clientAttachmentId: "att_backup",
      filename: "backup.txt",
      mediaType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      correlationId: "cor_attachment",
    });
    alice.attachments.uploadContent(attachment.attachmentId, body);
    alice.attachments.commit(attachment.attachmentId);
    alice.attachments.markDelivered(attachment.attachmentId);
    alice.attachments.acknowledge(attachment.attachmentId, "cor_ack");
    alice.deviceRequests.enqueue({
      requestId: "device_req_pending_backup",
      deviceId: session.deviceId,
      pairingGeneration: 1,
      grantRevision: 1,
      risk: "read",
      capability: { id: "org.agentlife.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.agentlife.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: {},
      correlationId: "cor_device",
    });

    const rotation = new IdentityRotationService({ storageRoot });
    const receipt = await rotation.rotate({
      accountId: "acct_alice",
      previousIdentityRef: "spki_initial",
      nextIdentityRef: "spki_new",
      signedByPrevious: "rotation_proof",
      correlationId: "cor_rotate",
    });
    expect(receipt.accountId).toBe("acct_alice");
    expect(receipt.previousIdentityRef).toBe("spki_initial");
    expect(receipt.nextIdentityRef).toBe("spki_new");
    expect(receipt.masterKeyRef).toBe(initialMasterKeyRef);

    const reopened = await core.openGatewayAccount("acct_alice");
    expect(reopened.masterKeyRef).toBe(initialMasterKeyRef);
    const backup = await new GatewayBackupService({ storageRoot }).exportPortable("acct_alice");
    const backupJson = JSON.stringify(backup);

    expect(backup.accountId).toBe("acct_alice");
    expect(backup.masterKeyContinuitySha256).toHaveLength(64);
    expect(backupJson).toContain("backup.txt");
    expect(backupJson).not.toContain("backup password");
    expect(backupJson).not.toContain(session.refreshCredential);
    expect(backupJson).not.toContain(session.accessToken);
    expect(backupJson).not.toContain("backup must not contain this staged body");
    expect(backupJson).not.toContain("device_req_pending_backup");
    expect(backupJson).not.toContain("spki_new");
    expect(backupJson).not.toContain("rotation_proof");

    alice.close();
    reopened.close();
  });
});
