import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore, type GatewayCore, type GatewayResponse } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "open-android-intelligence-openclaw-logout-"));

type LiveSession = Readonly<{
  accountId: string;
  deviceId: string;
  sessionId: string;
  accessToken: string;
  refreshCredential: string;
}>;

const login = async (core: GatewayCore, accountId: string): Promise<LiveSession> => {
  const account = await core.openGatewayAccount(accountId);
  try {
    account.credentials.setPassword("correct horse battery staple");
    const bundle = account.sessions.createPasswordSession({
      username: accountId,
      password: "correct horse battery staple",
      installation: {
        installationId: "install_logout",
        displayName: "Logout phone",
        devicePublicKey: "LogoutDevicePublicKey",
      },
      correlationId: "cor_logout_login",
    });
    return {
      accountId,
      deviceId: bundle.deviceId,
      sessionId: bundle.sessionId,
      accessToken: bundle.accessToken,
      refreshCredential: bundle.refreshCredential,
    };
  } finally {
    account.close();
  }
};

const deleteCurrentSession = async (
  core: GatewayCore,
  session: LiveSession,
  revokeRefresh: boolean,
): Promise<GatewayResponse> =>
  core.handle({
    method: "DELETE",
    target: revokeRefresh
      ? "/open-android-intelligence/v2/sessions/current?revokeRefresh=true"
      : "/open-android-intelligence/v2/sessions/current",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "x-open-android-intelligence-account": session.accountId,
      "x-open-android-intelligence-device": session.deviceId,
      "x-open-android-intelligence-session": session.sessionId,
    },
  });

const deviceKeyCount = async (core: GatewayCore, session: LiveSession): Promise<number> => {
  const account = await core.openGatewayAccount(session.accountId);
  try {
    const row = account.store.database
      .prepare("SELECT COUNT(*) AS count FROM device_keys WHERE device_id = ?")
      .get(session.deviceId) as { count: number };
    return row.count;
  } finally {
    account.close();
  }
};

const activeRefreshCount = async (core: GatewayCore, session: LiveSession): Promise<number> => {
  const account = await core.openGatewayAccount(session.accountId);
  try {
    return account.sessions.activeRefreshCredentialCount(session.deviceId);
  } finally {
    account.close();
  }
};

describe("OpenClaw Gateway logout (contract §5.5 / §13)", () => {
  it("keeps the device key when revokeRefresh=true ends the login", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await login(core, "acct_logout");

    // Contract :796: logging out revokes the refresh credential and does *not*
    // delete the pairing. Only 解除配对 (D1) may remove the device key.
    const response = await deleteCurrentSession(core, session, true);
    expect(response.error).toBeUndefined();
    expect(response.data).toEqual({ sessionId: session.sessionId, refreshRevoked: true });

    await expect(deviceKeyCount(core, session)).resolves.toBe(1);
  });

  it("revokes the device refresh credential when revokeRefresh=true ends the login", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await login(core, "acct_logout");

    const response = await deleteCurrentSession(core, session, true);
    expect(response.error).toBeUndefined();

    // The refresh credential is gone, so a rotation with the old secret fails
    // instead of handing out a new access token.
    await expect(activeRefreshCount(core, session)).resolves.toBe(0);
    const account = await core.openGatewayAccount(session.accountId);
    try {
      // A credential that is no longer active is reuse evidence (§5.4), so the
      // rotation attempt is refused with the security code rather than a new
      // session.
      expect(() => account.sessions.refresh({
        refreshCredential: session.refreshCredential,
        installationId: "install_logout",
        deviceId: session.deviceId,
        correlationId: "cor_logout_after",
      })).toThrowError("REFRESH_REUSED");
    } finally {
      account.close();
    }
  });
});
