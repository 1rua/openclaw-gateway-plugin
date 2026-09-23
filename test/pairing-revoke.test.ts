import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createGatewayCore as buildGatewayCore,
  UNPAIR_TARGET,
  type GatewayCore,
  type GatewayResponse,
  type VerifiedRequestContext,
} from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "open-android-intelligence-openclaw-unpair-"));
const createGatewayCore = (options: Parameters<typeof buildGatewayCore>[0] = {}) =>
  buildGatewayCore({ ...options, attachmentMasterKey: Buffer.alloc(32, 0x7c) });

type LiveSession = Readonly<{
  accountId: string;
  deviceId: string;
  sessionId: string;
  accessToken: string;
}>;

/**
 * A logged-in device with every §13 resource class actually populated, so the
 * unpair sweep has something to revoke instead of vacuously succeeding.
 */
const pairedAccount = async (core: GatewayCore, accountId: string): Promise<LiveSession> => {
  const account = await core.openGatewayAccount(accountId);
  try {
    account.credentials.setPassword("correct horse battery staple");
    const first = account.sessions.createPasswordSession({
      username: accountId,
      password: "correct horse battery staple",
      installation: {
        installationId: "install_unpair",
        displayName: "Unpair phone",
        devicePublicKey: "UnpairDevicePublicKey",
      },
      correlationId: "cor_unpair_login",
    });
    // A second session of the same device: 解除配对 must end it too.
    const second = account.sessions.refresh({
      refreshCredential: first.refreshCredential,
      installationId: "install_unpair",
      deviceId: first.deviceId,
      correlationId: "cor_unpair_second_session",
    });
    account.deviceRequests.enqueue({
      requestId: "req_queued",
      deviceId: first.deviceId,
      pairingGeneration: 1,
      grantRevision: 1,
      risk: "write",
      capability: { pluginId: "mobile.sms", capabilityId: "query" },
      provider: { pluginId: "mobile.sms" },
      parameters: { limit: 1 },
      correlationId: "cor_unpair_enqueue",
    });
    const attachment = account.attachments.create({
      clientAttachmentId: "client_unpair_attachment",
      filename: "note.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      deviceId: first.deviceId,
      pairingGeneration: 1,
      correlationId: "cor_unpair_attachment",
    });
    await account.attachments.uploadContent(attachment.attachmentId, Buffer.from("hello", "utf8"));
    account.attachments.commit(attachment.attachmentId);
    return {
      accountId,
      deviceId: first.deviceId,
      sessionId: second.sessionId,
      accessToken: second.accessToken,
    };
  } finally {
    account.close();
  }
};

const contextFor = (session: LiveSession, requestId: string): VerifiedRequestContext => Object.freeze({
  accountId: session.accountId,
  deviceId: session.deviceId,
  sessionId: session.sessionId,
  requestId,
  correlationId: `cor_${requestId}`,
  pairingGeneration: 1,
  grantRevision: 1,
});

const unpair = async (
  core: GatewayCore,
  session: LiveSession,
  requestId: string,
  options: Readonly<{ idempotencyKey?: string }> = {},
): Promise<GatewayResponse> =>
  core.handle({
    context: contextFor(session, requestId),
    method: "DELETE",
    target: UNPAIR_TARGET,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.idempotencyKey === undefined ? { idempotencyKey: requestId } : {}),
  });

const countRows = async (
  core: GatewayCore,
  accountId: string,
  statements: readonly { label: string; sql: string; parameters: readonly string[] }[],
): Promise<Record<string, number>> => {
  const account = await core.openGatewayAccount(accountId);
  try {
    const counts: Record<string, number> = {};
    for (const statement of statements) {
      const row = account.store.database.prepare(statement.sql).get(...statement.parameters) as { count: number };
      counts[statement.label] = row.count;
    }
    return counts;
  } finally {
    account.close();
  }
};

describe("OpenClaw Gateway 解除配对 (contract §13 / §5.6, D1)", () => {
  it("revokes the five §13 resource classes and every access session of the device", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await pairedAccount(core, "acct_unpair");
    const accountBeforeUnpair = await core.openGatewayAccount(session.accountId);
    let otherDeviceAttachmentId: string;
    try {
      const otherDeviceAttachment = accountBeforeUnpair.attachments.create({
        clientAttachmentId: "client_other_device_attachment",
        filename: "other-device.txt",
        mediaType: "text/plain",
        sizeBytes: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        deviceId: "device_other",
        pairingGeneration: 1,
        correlationId: "cor_other_device_attachment",
      });
      otherDeviceAttachmentId = otherDeviceAttachment.attachmentId;
      await accountBeforeUnpair.attachments.uploadContent(otherDeviceAttachmentId, Buffer.from("hello", "utf8"));
      accountBeforeUnpair.attachments.commit(otherDeviceAttachmentId);
    } finally {
      accountBeforeUnpair.close();
    }

    const response = await unpair(core, session, "req_unpair_1");
    expect(response.error).toBeUndefined();
    expect(response.data).toEqual({
      deviceId: session.deviceId,
      deviceKeysRevoked: true,
      refreshRevoked: true,
      grantsRevoked: true,
      deviceRequestsRevoked: true,
      unconfirmedAttachmentsRevoked: true,
      sessionsRevoked: true,
    });

    const counts = await countRows(core, session.accountId, [
      { label: "deviceKeys", sql: "SELECT COUNT(*) AS count FROM device_keys WHERE device_id = ?", parameters: [session.deviceId] },
      { label: "refresh", sql: "SELECT COUNT(*) AS count FROM refresh_credentials WHERE device_id = ? AND status = 'active'", parameters: [session.deviceId] },
      // §13 empties the queue: the documented `cancel` transition takes each
      // live request out of it, so nothing the device could still answer is left.
      { label: "liveDeviceRequests", sql: "SELECT COUNT(*) AS count FROM device_requests WHERE device_id = ? AND state IN ('pending','claimed','cancel_requested')", parameters: [session.deviceId] },
      { label: "targetPairingAttachments", sql: "SELECT COUNT(*) AS count FROM attachments WHERE acknowledged_at IS NULL AND state != 'deleted' AND owner_device_id = ? AND owner_pairing_generation = ?", parameters: [session.deviceId, "1"] },
      { label: "otherDeviceAttachments", sql: "SELECT COUNT(*) AS count FROM attachments WHERE acknowledged_at IS NULL AND state != 'deleted' AND owner_device_id = ? AND owner_pairing_generation = ?", parameters: ["device_other", "1"] },
      { label: "activeSessions", sql: "SELECT COUNT(*) AS count FROM access_sessions WHERE device_id = ? AND status = 'active'", parameters: [session.deviceId] },
    ]);
    expect(counts).toEqual({
      deviceKeys: 0,
      refresh: 0,
      liveDeviceRequests: 0,
      targetPairingAttachments: 0,
      otherDeviceAttachments: 1,
      activeSessions: 0,
    });

    // The queue was emptied with the documented transition, so the cancellation
    // is announced on the event stream instead of being a silent row change.
    const account = await core.openGatewayAccount(session.accountId);
    try {
      const cancelled = account.events.readAfter(null)
        .filter((event) => event.eventType === "device.request.cancel.requested");
      expect(cancelled.map((event) => event.payload)).toEqual([{ requestId: "req_queued" }]);
      expect(account.attachments.countUnconfirmed(session.deviceId, 1)).toBe(0);
      expect(account.attachments.get(otherDeviceAttachmentId).hasStagedBytes).toBe(true);
    } finally {
      account.close();
    }
  });

  it("deletes the device key so no later request of that pairing can be verified", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await pairedAccount(core, "acct_unpair");

    const response = await unpair(core, session, "req_unpair_key");
    expect(response.error).toBeUndefined();

    const account = await core.openGatewayAccount(session.accountId);
    try {
      // The row itself is gone: removing the pairing is a resource-level
      // deletion, not a flag on a key that stays behind.
      const keyRow = account.store.database
        .prepare("SELECT 1 AS present FROM device_keys WHERE device_id = ?")
        .get(session.deviceId) as Record<string, unknown> | undefined;
      expect(keyRow).toBeUndefined();
      // `resolveSession` joins the session to its key: with the key gone there
      // is nothing left to check a signature against, so the authentication seam
      // fails closed instead of resolving stale facts.
      expect(account.sessions.resolveSession(
        session.accessToken,
        session.sessionId,
        session.deviceId,
      )).toBeUndefined();
    } finally {
      account.close();
    }
  });

  it("answers PAIRING_REQUIRED when the device has no active pairing left", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await pairedAccount(core, "acct_unpair");

    const first = await unpair(core, session, "req_unpair_first");
    expect(first.error).toBeUndefined();

    // A second, *new* request: there is nothing left to unpaired, and the
    // answer has to name that instead of reporting another success.
    const second = await unpair(core, session, "req_unpair_second");
    expect(second.error).toMatchObject({ code: "PAIRING_REQUIRED" });
    expect(second.data).toBeUndefined();
  });

  it("keeps refusing a stale request id instead of destroying a fresh re-pair", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await pairedAccount(core, "acct_unpair");

    const first = await unpair(core, session, "req_unpair_first");
    const refused = await unpair(core, session, "req_unpair_stale");
    expect(first.error).toBeUndefined();
    expect(refused.error).toMatchObject({ code: "PAIRING_REQUIRED" });

    // The device pairs again and then an old request id is replayed. §12 makes
    // the refusal the terminal outcome of that id: replaying it must not sweep
    // the pairing that was created after the refusal.
    const account = await core.openGatewayAccount(session.accountId);
    try {
      account.store.database
        .prepare("INSERT INTO device_keys(device_id, installation_id, public_key, pairing_generation, grant_revision, registered_at) VALUES (?, ?, ?, 2, 1, ?)")
        .run(session.deviceId, "install_unpair", "RePairedPublicKey", new Date().toISOString());
    } finally {
      account.close();
    }

    const replay = await unpair(core, session, "req_unpair_stale");
    expect(replay.error).toMatchObject({ code: "PAIRING_REQUIRED" });

    const survivor = await core.openGatewayAccount(session.accountId);
    try {
      expect(survivor.pairings.hasActivePairing(session.deviceId)).toBe(true);
    } finally {
      survivor.close();
    }
  });

  it("returns the same terminal outcome when the Idempotency-Key is replayed", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await pairedAccount(core, "acct_unpair");

    const first = await unpair(core, session, "req_unpair_replay");
    const replay = await unpair(core, session, "req_unpair_replay");
    expect(first.error).toBeUndefined();
    expect(replay).toEqual(first);

    // The replay must not re-run the sweep: one bump and one audit trail for one
    // unpair, not one per retry.
    const account = await core.openGatewayAccount(session.accountId);
    try {
      const generation = account.store.database
        .prepare("SELECT value FROM account_metadata WHERE key = 'pairing_generation'")
        .get() as { value: string };
      expect(generation.value).toBe("2");
      const revokedEvents = account.audit.list()
        .filter((event) => event.eventType === "pairing.revoked");
      expect(revokedEvents).toHaveLength(1);
    } finally {
      account.close();
    }
  });

  it("keeps unpair behind the verified-request seam instead of the logout waiver", async () => {
    const { createGatewayRoutes } = await import("../src/http/routes.js");
    const routes = createGatewayRoutes({
      core: createGatewayCore({ storageRoot: tempRoot() }),
      hostVersion: "2026.7.1",
    });
    const route = routes.find((candidate) => candidate.path === UNPAIR_TARGET);
    expect(route).toBeDefined();
    expect(route?.auth).toBe("plugin");

    // D4 waives the signature of `DELETE /sessions/current` only. Unpair stays
    // on the authenticated side: with no verified context the route refuses
    // instead of reaching the core with an unauthenticated identity.
    const response = await route?.handle({ method: "DELETE", target: UNPAIR_TARGET });
    expect(response?.statusCode).toBe(401);
    expect(response?.body.error).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("refuses an unpair whose Idempotency-Key is not bound to the signed request id", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await pairedAccount(core, "acct_unpair");

    // §6.1/§6.5: an authenticated DELETE carries `Idempotency-Key` exactly once
    // and equal to the signed request id. Omitting it is not "no key", it is a
    // request this host must not execute.
    const response = await core.handle({
      context: contextFor(session, "req_unpair_no_key"),
      method: "DELETE",
      target: UNPAIR_TARGET,
    });
    expect(response.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("revokes the same pairing from the local admin surface", async () => {
    const { createAdminService } = await import("../src/admin/service.js");
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const session = await pairedAccount(core, "acct_admin");
    const service = createAdminService({ core, hostVersion: "2026.7.1" });

    await expect(service.revokePairing({
      accountId: session.accountId,
      deviceId: session.deviceId,
    })).resolves.toMatchObject({ ok: false, error: { code: "LOCAL_CONFIRMATION_REQUIRED" } });

    const result = await service.execute({
      command: "pairing.revoke",
      accountId: session.accountId,
      deviceId: session.deviceId,
      localConfirmation: true,
    });
    // The same seven fields the wire endpoint answers with, and nothing else.
    expect(result).toEqual({
      ok: true,
      operation: "pairing.revoke",
      readOnly: false,
      data: {
        deviceId: session.deviceId,
        deviceKeysRevoked: true,
        refreshRevoked: true,
        grantsRevoked: true,
        deviceRequestsRevoked: true,
        unconfirmedAttachmentsRevoked: true,
        sessionsRevoked: true,
      },
    });

    // The wire endpoint never uses `localConfirmation`, but this surface does.
    const incompatible = createAdminService({ core, hostVersion: "2026.8.0" });
    expect(incompatible.readOnly).toBe(true);
    await expect(incompatible.revokePairing({
      accountId: session.accountId,
      deviceId: session.deviceId,
      localConfirmation: true,
    })).resolves.toMatchObject({ ok: false, readOnly: true, error: { code: "HOST_INCOMPATIBLE" } });
  });
});
