import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateGatewayValue } from "../../../gateway-contract/src/schema-registry.js";
import { createGatewayCore, type GatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "open-android-intelligence-openclaw-grant-"));

const PASSWORD = "correct horse battery staple";
const ACCOUNT_ID = "acct_grant_events";

type PairedDevice = Readonly<{
  deviceId: string;
  sessionId: string;
  accessToken: string;
}>;

/**
 * A password login is what registers the device key row this seam bumps: the
 * `grant_revision` on that row is the pairing's authorization revision.
 */
const pairedDevice = async (core: GatewayCore, accountId: string = ACCOUNT_ID): Promise<PairedDevice> => {
  const account = await core.openGatewayAccount(accountId);
  try {
    account.credentials.setPassword(PASSWORD);
    const bundle = account.sessions.createPasswordSession({
      username: accountId,
      password: PASSWORD,
      installation: {
        installationId: "install_grant_events",
        displayName: "Grant phone",
        devicePublicKey: "GrantDevicePublicKey",
      },
      correlationId: "cor_login",
    });
    return Object.freeze({
      deviceId: bundle.deviceId,
      sessionId: bundle.sessionId,
      accessToken: bundle.accessToken,
    });
  } finally {
    account.close();
  }
};

const eventsOfType = async (
  core: GatewayCore,
  accountId: string,
  eventType: string,
): Promise<readonly { correlationId: string; occurredAt: string; payload: Readonly<Record<string, unknown>> }[]> => {
  const account = await core.openGatewayAccount(accountId);
  try {
    return account.events.readAfter(null)
      .filter((event) => event.eventType === eventType)
      .map((event) => ({
        correlationId: event.correlationId,
        occurredAt: event.occurredAt,
        payload: { ...event.payload },
      }));
  } finally {
    account.close();
  }
};

const auditOfType = async (
  core: GatewayCore,
  accountId: string,
  eventType: string,
): Promise<readonly { actor: Readonly<Record<string, unknown>>; subject: Readonly<Record<string, unknown>>; correlationId: string }[]> => {
  const account = await core.openGatewayAccount(accountId);
  try {
    return account.audit.list()
      .filter((entry) => entry.eventType === eventType)
      .map((entry) => ({ actor: entry.actor, subject: entry.subject, correlationId: entry.correlationId }));
  } finally {
    account.close();
  }
};

describe("OpenClaw Gateway grant revisions and session.revoked events", () => {
  it("bumps the grant revision monotonically and persists it across reopen", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const { deviceId } = await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    let secondRevision: number;
    try {
      const first = account.pairings.bumpGrantRevision({ deviceId, correlationId: "cor_bump_first" });
      const second = account.pairings.bumpGrantRevision({ deviceId, correlationId: "cor_bump_second" });
      expect(first.deviceId).toBe(deviceId);
      secondRevision = second.grantRevision;
      expect([first.grantRevision, second.grantRevision]).toEqual([2, 3]);
    } finally {
      account.close();
    }
    expect(secondRevision).toBe(3);

    const reopened = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      const row = reopened.store.database
        .prepare("SELECT grant_revision FROM device_keys WHERE device_id = ?")
        .get(deviceId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(Number(row!.grant_revision)).toBe(3);
    } finally {
      reopened.close();
    }
  });

  it("answers PAIRING_REQUIRED when the device has no pairing to bump", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      expect(() =>
        account.pairings.bumpGrantRevision({ deviceId: "dev_absent", correlationId: "cor_bump_absent" }),
      ).toThrowError("PAIRING_REQUIRED");
    } finally {
      account.close();
    }
  });

  it("appends a schema-valid pairing.grant.changed event with the exact payload shape", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const { deviceId } = await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    let bumpedRevision: number;
    try {
      const bumped = account.pairings.bumpGrantRevision({ deviceId, correlationId: "cor_grant_event" });
      bumpedRevision = bumped.grantRevision;
    } finally {
      account.close();
    }
    expect(bumpedRevision).toBe(2);

    const grantEvents = await eventsOfType(core, ACCOUNT_ID, "pairing.grant.changed");
    expect(grantEvents).toHaveLength(1);
    const event = grantEvents[0]!;
    expect(event.correlationId).toBe("cor_grant_event");
    // Field-by-field: the required `grantRevision` and nothing else — the
    // optional fields this host has no real values for (`pluginId`,
    // `authorKeyId`, `capabilityId`, `capabilityVersion`, and the signed-grant
    // `grantDigest` of the contract) are omitted rather than fabricated.
    expect(event.payload).toEqual({ grantRevision: bumpedRevision });
    expect(validateGatewayValue("event.pairingGrantChangedPayload", event.payload).ok).toBe(true);
    expect(validateGatewayValue("event", {
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
      payload: event.payload,
    }).ok).toBe(true);
  });

  it("answers GRANT_STALE to a claim carrying the pre-bump revision", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const { deviceId } = await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      const bumped = account.pairings.bumpGrantRevision({ deviceId, correlationId: "cor_bump_stale" });
      account.deviceRequests.enqueue({
        requestId: "device_req_grant_stale",
        deviceId,
        pairingGeneration: 1,
        grantRevision: bumped.grantRevision,
        risk: "read",
        capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
        provider: { pluginId: "org.openandroidintelligence.sms", authorKeyId: "sha256:" + "a".repeat(64) },
        parameters: { query: "from:alice" },
        correlationId: "cor_enqueue_stale",
      });
      // The request itself was bound to the *new* revision, so a claim that
      // still carries the old one cannot be answered: the event is a
      // notification only and never widens the request-path decision.
      expect(() =>
        account.deviceRequests.claim({
          requestId: "device_req_grant_stale",
          deviceId,
          pairingGeneration: 1,
          grantRevision: 1,
          correlationId: "cor_claim_stale",
        }),
      ).toThrowError("GRANT_STALE");
      const claimed = account.deviceRequests.claim({
        requestId: "device_req_grant_stale",
        deviceId,
        pairingGeneration: 1,
        grantRevision: bumped.grantRevision,
        correlationId: "cor_claim_current",
      });
      expect(claimed.grantRevision).toBe(bumped.grantRevision);
    } finally {
      account.close();
    }
  });

  it("writes the audit entry for the bump in the same commit", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const { deviceId } = await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      account.pairings.bumpGrantRevision({ deviceId, correlationId: "cor_bump_audit" });
    } finally {
      account.close();
    }

    const entries = await auditOfType(core, ACCOUNT_ID, "pairing.grant.changed");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toEqual({ accountId: ACCOUNT_ID, deviceId });
    expect(entries[0]!.subject).toEqual({ deviceId, grantRevision: 2 });
    expect(entries[0]!.correlationId).toBe("cor_bump_audit");
  });

  it("leaves no revision, no audit and no event when the commit fails", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const { deviceId } = await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      account.store.failNextCommit.value = true;
      expect(() =>
        account.pairings.bumpGrantRevision({ deviceId, correlationId: "cor_bump_failed" }),
      ).toThrowError("OUTCOME_UNKNOWN");
    } finally {
      account.close();
    }

    const reopened = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      const row = reopened.store.database
        .prepare("SELECT grant_revision FROM device_keys WHERE device_id = ?")
        .get(deviceId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(Number(row!.grant_revision)).toBe(1);
      expect(await eventsOfType(core, ACCOUNT_ID, "pairing.grant.changed")).toHaveLength(0);
      expect(await auditOfType(core, ACCOUNT_ID, "pairing.grant.changed")).toHaveLength(0);
    } finally {
      reopened.close();
    }
  });

  it("exposes grant.bump as the management-plane entry, gated like pairing.revoke", async () => {
    const { createAdminService } = await import("../src/admin/service.js");
    const { bindAdminService, runAdminCommand } = await import("../src/admin/cli.js");
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const { deviceId } = await pairedDevice(core);
    const service = createAdminService({ core, hostVersion: "2026.7.1" });
    const readOnly = createAdminService({ core, hostVersion: "2026.8.0" });

    await expect(readOnly.grantBump({
      accountId: ACCOUNT_ID,
      deviceId,
      localConfirmation: true,
    })).resolves.toMatchObject({ ok: false, readOnly: true, error: { code: "HOST_INCOMPATIBLE" } });
    await expect(service.grantBump({ accountId: ACCOUNT_ID, deviceId }))
      .resolves.toMatchObject({ ok: false, error: { code: "LOCAL_CONFIRMATION_REQUIRED" } });
    await expect(service.grantBump({
      accountId: ACCOUNT_ID,
      deviceId: "dev_missing!!",
      localConfirmation: true,
    })).resolves.toMatchObject({ ok: false, error: { code: "SCHEMA_INVALID" } });
    await expect(service.grantBump({
      accountId: ACCOUNT_ID,
      deviceId: "dev_absent",
      localConfirmation: true,
    })).resolves.toMatchObject({ ok: false, error: { code: "PAIRING_REQUIRED" } });

    const bumped = await service.grantBump({
      accountId: ACCOUNT_ID,
      deviceId,
      localConfirmation: true,
    });
    expect(bumped).toEqual({
      ok: true,
      operation: "grant.bump",
      readOnly: false,
      data: { deviceId, grantRevision: 2 },
    });

    // The execute dispatch and the CLI spelling answer with the same result.
    await expect(service.execute({
      command: "grant.bump",
      accountId: ACCOUNT_ID,
      deviceId,
      localConfirmation: true,
    })).resolves.toMatchObject({ ok: true, data: { grantRevision: 3 } });

    bindAdminService(service);
    const viaCli = await runAdminCommand(["grant", "bump", ACCOUNT_ID, deviceId, "--confirm-local"]);
    expect(viaCli).toMatchObject({ ok: true, operation: "grant.bump", data: { grantRevision: 4 } });

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      const row = account.store.database
        .prepare("SELECT grant_revision FROM device_keys WHERE device_id = ?")
        .get(deviceId) as Record<string, unknown>;
      expect(Number(row.grant_revision)).toBe(4);
      // One event per bump: the service entry, the execute dispatch and the
      // CLI spelling each moved the revision exactly once (2 → 3 → 4).
      const grantEvents = account.events.readAfter(null)
        .filter((event) => event.eventType === "pairing.grant.changed");
      expect(grantEvents).toHaveLength(3);
    } finally {
      account.close();
    }
  });

  it("appends a schema-valid session.revoked event when a session is revoked", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const { deviceId, sessionId, accessToken } = await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      account.sessions.revokeSession(sessionId, "cor_session_revoke");
      // The revoked session no longer resolves: the revocation is real, not
      // just a line on the event stream.
      expect(account.sessions.resolveSession(accessToken, sessionId, deviceId)).toBeUndefined();
    } finally {
      account.close();
    }

    const revoked = await eventsOfType(core, ACCOUNT_ID, "session.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.correlationId).toBe("cor_session_revoke");
    // Field-by-field per $defs/sessionRevokedPayload: the device id is read
    // from the session row, and nothing else rides along.
    expect(revoked[0]!.payload).toEqual({ sessionId, deviceId });
    expect(validateGatewayValue("event.sessionRevokedPayload", revoked[0]!.payload).ok).toBe(true);
    expect(validateGatewayValue("event", {
      correlationId: revoked[0]!.correlationId,
      occurredAt: revoked[0]!.occurredAt,
      payload: revoked[0]!.payload,
    }).ok).toBe(true);

    // The pre-existing audit behavior survives untouched.
    const audits = await auditOfType(core, ACCOUNT_ID, "session.revoked");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subject).toEqual({ sessionId });
  });

  it("keeps the audit line but appends no event for a session that does not exist", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    await pairedDevice(core);

    const account = await core.openGatewayAccount(ACCOUNT_ID);
    try {
      account.sessions.revokeSession("sess_absent", "cor_revoke_absent");
    } finally {
      account.close();
    }

    // Nothing was revoked, so the stream must not carry a fabricated
    // revocation; the audit line keeps its pre-existing behavior.
    expect(await eventsOfType(core, ACCOUNT_ID, "session.revoked")).toHaveLength(0);
    const audits = await auditOfType(core, ACCOUNT_ID, "session.revoked");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subject).toEqual({ sessionId: "sess_absent" });
  });
});
