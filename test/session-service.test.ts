import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "agent-life-openclaw-session-"));

describe("OpenClaw Gateway session service", () => {
  it("rotates refresh credentials and revokes a device when an old refresh credential is reused", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const alice = await core.openGatewayAccount("acct_alice");
    const bob = await core.openGatewayAccount("acct_bob");

    const first = alice.sessions.createPasswordSession({
      username: "alice",
      password: "correct horse battery staple",
      installation: {
        installationId: "install_same",
        displayName: "Alice phone",
        devicePublicKey: "AliceDevicePublicKey",
      },
      correlationId: "cor_login",
    });
    const rotated = alice.sessions.refresh({
      refreshCredential: first.refreshCredential,
      installationId: "install_same",
      deviceId: first.deviceId,
      correlationId: "cor_refresh",
    });

    expect(rotated.refreshCredential).not.toBe(first.refreshCredential);
    await expect(() =>
      bob.sessions.refresh({
        refreshCredential: rotated.refreshCredential,
        installationId: "install_same",
        deviceId: first.deviceId,
        correlationId: "cor_cross_account",
      }),
    ).toThrowError("AUTHENTICATION_FAILED");
    await expect(() =>
      alice.sessions.refresh({
        refreshCredential: first.refreshCredential,
        installationId: "install_same",
        deviceId: first.deviceId,
        correlationId: "cor_reuse",
      }),
    ).toThrowError("REFRESH_REUSED");
    expect(alice.sessions.activeRefreshCredentialCount(first.deviceId)).toBe(0);

    const auditJson = JSON.stringify(alice.audit.list());
    expect(auditJson).toContain("session.refresh.reused");
    expect(auditJson).not.toContain("correct horse battery staple");
    expect(auditJson).not.toContain(first.refreshCredential);

    alice.close();
    bob.close();
  });
});
