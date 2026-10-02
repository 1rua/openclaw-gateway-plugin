import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGatewayCore } from "../src/core/gateway-core.js";
import { createAdminPanel, createAdminService } from "../src/admin/service.js";
import { bindAdminService, runAdminCommand } from "../src/admin/cli.js";

const executeAdminCommand = (service: ReturnType<typeof createAdminService>, args: readonly string[]) => {
  bindAdminService(service);
  return runAdminCommand(args);
};

const fixture = async () => {
  const core = createGatewayCore({ storageRoot: mkdtempSync(join(tmpdir(), "oai-password-reset-")), attachmentMasterKey: Buffer.alloc(32, 0x43) });
  const service = createAdminService({ core, hostVersion: "2026.7.1" });
  const panel = createAdminPanel(service);
  expect((await panel.createAccount({ accountId: "alice", password: "old password", localConfirmation: true })).ok).toBe(true);
  const account = await core.openGatewayAccount("alice");
  const login = (installationId: string, password = "old password") => account.sessions.createPasswordSession({
    username: "alice", password,
    installation: { installationId, displayName: "Phone", devicePublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    correlationId: "cor_password_reset",
  });
  return { core, service, panel, account, login };
};

describe("account create and password reset boundaries", () => {
  it("rejects duplicate UI and CLI creation without changing password or refresh credentials", async () => {
    const { service, panel, account, login } = await fixture();
    try {
      const session = login("install_one");
      const before = account.store.database.prepare("SELECT * FROM account_credentials").all();
      for (const result of [
        await panel.createAccount({ accountId: "alice", password: "replacement", localConfirmation: true }),
        await executeAdminCommand(service, ["account", "create", "alice", "--password", "replacement", "--confirm-local"]),
      ]) expect(result).toMatchObject({ ok: false, error: { code: "ACCOUNT_EXISTS" } });
      expect(account.store.database.prepare("SELECT * FROM account_credentials").all()).toEqual(before);
      expect(account.credentials.verifyPassword("old password")).toBe(true);
      expect(account.credentials.verifyPassword("replacement")).toBe(false);
      expect(account.sessions.refresh({ refreshCredential: session.refreshCredential, installationId: "install_one", deviceId: session.deviceId, correlationId: "cor_still_valid" }).accessToken).toBeTruthy();
    } finally { account.close(); }
  });

  it("resets all device refresh families atomically while retaining pairing keys", async () => {
    const { service, account, login } = await fixture();
    try {
      const first = login("install_one");
      const second = login("install_two");
      const keys = account.store.database.prepare("SELECT * FROM device_keys ORDER BY device_id").all();
      expect(await executeAdminCommand(service, ["account", "reset-password", "alice", "--password", "new password", "--confirm-local"])).toMatchObject({ ok: true, operation: "account.reset-password" });
      expect(account.store.database.prepare("SELECT * FROM device_keys ORDER BY device_id").all()).toEqual(keys);
      expect(account.credentials.verifyPassword("old password")).toBe(false);
      for (const [session, installationId] of [[first, "install_one"], [second, "install_two"]] as const) {
        expect(() => account.sessions.refresh({ refreshCredential: session.refreshCredential, installationId, deviceId: session.deviceId, correlationId: "cor_reset_refused" })).toThrow();
      }
      expect(login("install_one", "new password").accessToken).toBeTruthy();
    } finally { account.close(); }
  });

  it("rolls back the password if refresh revocation cannot commit", async () => {
    const { panel, account, login } = await fixture();
    try {
      login("install_one");
      account.store.database.exec("CREATE TRIGGER fail_reset BEFORE UPDATE ON refresh_credentials BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END;");
      expect((await panel.resetPassword({ accountId: "alice", password: "new password", localConfirmation: true })).ok).toBe(false);
      expect(account.credentials.verifyPassword("old password")).toBe(true);
      expect(account.sessions.activeRefreshCredentialCount(account.store.database.prepare("SELECT device_id FROM device_keys").get()!.device_id as string)).toBe(1);
    } finally { account.close(); }
  });
});
