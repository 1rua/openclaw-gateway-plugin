import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore, openGatewayAccount } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "open-android-intelligence-openclaw-isolation-"));
const context = (overrides: Partial<{
  accountId: string;
  deviceId: string;
  sessionId: string;
  requestId: string;
  correlationId: string;
  pairingGeneration: number;
  grantRevision: number;
}> = {}) => ({
  accountId: overrides.accountId ?? "acct_alice",
  deviceId: overrides.deviceId ?? "dev_1",
  sessionId: overrides.sessionId ?? "sess_1",
  requestId: overrides.requestId ?? "req_1",
  correlationId: overrides.correlationId ?? "cor_1",
  pairingGeneration: overrides.pairingGeneration ?? 1,
  grantRevision: overrides.grantRevision ?? 1,
});

describe("OpenClaw Gateway account isolation", () => {
  it("opens different accounts under separate file roots before any shared database exists", async () => {
    const originalCwd = process.cwd();
    process.chdir(tempRoot());
    const alice = await openGatewayAccount("acct_alice");
    const bob = await openGatewayAccount("acct_bob");

    try {
      expect(alice.paths.database).not.toBe(bob.paths.database);
      expect(alice.paths.attachments.startsWith(bob.paths.root)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }

    alice.close();
    bob.close();
  });

  it("does not share SSE cursors or conversation attachment references across account databases", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const alice = await core.openGatewayAccount("acct_alice");
    const bob = await core.openGatewayAccount("acct_bob");

    const event = alice.events.append({
      eventType: "gateway.notice",
      correlationId: "cor_evt",
      payload: { summary: "ready" },
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(alice.events.readAfter(null, new Date("2026-08-24T12:00:01.000Z")).map((item) => item.eventId)).toContain(event.eventId);
    expect(() => bob.events.readAfter(event.eventId)).toThrowError("CURSOR_EXPIRED");
    expect(() => alice.events.readAfter(event.eventId, new Date("2026-08-25T12:00:01.000Z"))).toThrowError("CURSOR_EXPIRED");

    const conversation = bob.conversations.create({
      clientConversationId: "conv_client_bob",
      title: "Bob thread",
      correlationId: "cor_bob_conversation",
    });
    expect(() =>
      bob.conversations.acceptMessage({
        conversationId: conversation.conversationId,
        clientMessageId: "msg_client_bob",
        text: "use alice attachment",
        attachmentIds: ["att_alice_only"],
        deviceId: "dev_bob",
        requestId: "req_bob_message",
        correlationId: "cor_bob_message",
      }),
    ).toThrowError("ATTACHMENT_EXPIRED");

    const auditJson = JSON.stringify(bob.audit.list());
    expect(auditJson).not.toContain("use alice attachment");

    alice.close();
    bob.close();
  });

  it("handles identity override, idempotency replay/conflict, expired idempotency and SSE cursor failures at the GatewayCore entry", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    const oldEvent = account.events.append({
      eventType: "gateway.notice",
      correlationId: "cor_old_cursor",
      payload: { summary: "old" },
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    account.close();

    await expect(core.handle({
      context: context({ requestId: "req_identity", correlationId: "cor_identity" }),
      method: "POST",
      target: "/open-android-intelligence/v2/conversations",
      idempotencyKey: "req_identity",
      body: { clientConversationId: "conv_client_identity", accountId: "acct_bob" },
    })).resolves.toMatchObject({ error: { code: "IDENTITY_OVERRIDE_REJECTED" } });

    const createRequest = {
      context: context({ requestId: "req_create", correlationId: "cor_create" }),
      method: "POST" as const,
      target: "/open-android-intelligence/v2/conversations",
      idempotencyKey: "req_create",
      body: { clientConversationId: "conv_client_handle", title: "Handle thread" },
      now: new Date("2026-08-27T00:00:00.000Z"),
    };
    const first = await core.handle(createRequest);
    const replay = await core.handle(createRequest);
    expect(replay).toEqual(first);
    await expect(core.handle({
      ...createRequest,
      body: { clientConversationId: "conv_client_handle_changed", title: "Changed" },
    })).resolves.toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });

    const expiredLedgerAccount = await core.openGatewayAccount("acct_alice");
    expiredLedgerAccount.store.database
      .prepare("UPDATE idempotency_ledger SET expires_at = ? WHERE device_id = ? AND request_id = ?")
      .run("2026-08-27T00:00:01.000Z", "dev_1", "req_create");
    expiredLedgerAccount.close();
    await expect(core.handle({
      ...createRequest,
      now: new Date("2026-08-27T00:00:02.000Z"),
    })).resolves.toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });

    await expect(core.handle({
      context: context({ requestId: "req_cursor_conflict", correlationId: "cor_cursor_conflict" }),
      method: "GET",
      target: `/open-android-intelligence/v2/events?cursor=${oldEvent.eventId}`,
      lastEventId: "evt_different",
    })).resolves.toMatchObject({ error: { code: "CURSOR_CONFLICT" } });
    await expect(core.handle({
      context: context({ requestId: "req_cursor_expired", correlationId: "cor_cursor_expired" }),
      method: "GET",
      target: `/open-android-intelligence/v2/events?cursor=${oldEvent.eventId}`,
      lastEventId: oldEvent.eventId,
      now: new Date("2026-08-25T12:00:01.000Z"),
    })).resolves.toMatchObject({
      error: {
        code: "CURSOR_EXPIRED",
        details: { recoverableResources: ["conversations", "attachments", "device-requests"] },
      },
    });
  });

  it("does not let a device result use body grantRevision instead of the verified context", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    account.deviceRequests.enqueue({
      requestId: "device_req_handle",
      deviceId: "dev_1",
      pairingGeneration: 1,
      grantRevision: 7,
      risk: "read",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: {},
      correlationId: "cor_enqueue",
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    account.close();

    const claim = await core.handle({
      context: context({ requestId: "req_claim", correlationId: "cor_claim", grantRevision: 7 }),
      method: "POST",
      target: "/open-android-intelligence/v2/device-requests/device_req_handle/claim",
      idempotencyKey: "req_claim",
      now: new Date("2026-08-27T00:01:00.000Z"),
    });
    const receipt = claim.data?.receipt as { claimId: string; grantRevision: number };

    await expect(core.handle({
      context: context({ requestId: "req_result", correlationId: "cor_result", grantRevision: 8 }),
      method: "POST",
      target: "/open-android-intelligence/v2/device-requests/device_req_handle/result",
      idempotencyKey: "req_result",
      body: {
        claimId: receipt.claimId,
        grantRevision: receipt.grantRevision,
        result: { outcome: "succeeded", data: { ok: true } },
      },
      now: new Date("2026-08-27T00:02:00.000Z"),
    })).resolves.toMatchObject({ error: { code: "GRANT_STALE" } });
  });

  it("revalidates device claim and result bindings before returning an idempotent replay", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    account.deviceRequests.enqueue({
      requestId: "device_req_replay_binding",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      risk: "read",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: {},
      correlationId: "cor_enqueue_replay_binding",
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    account.close();

    const claimRequest = {
      context: context({ requestId: "req_replay_claim", correlationId: "cor_replay_claim", pairingGeneration: 4, grantRevision: 7 }),
      method: "POST" as const,
      target: "/open-android-intelligence/v2/device-requests/device_req_replay_binding/claim",
      idempotencyKey: "req_replay_claim",
      now: new Date("2026-08-27T00:01:00.000Z"),
    };
    const claim = await core.handle(claimRequest);
    expect(claim.data?.receipt).toBeDefined();
    await expect(core.handle({
      ...claimRequest,
      context: { ...claimRequest.context, pairingGeneration: 5 },
    })).resolves.toMatchObject({ error: { code: "PAIRING_GENERATION_STALE" } });
    await expect(core.handle({
      ...claimRequest,
      context: { ...claimRequest.context, grantRevision: 8 },
    })).resolves.toMatchObject({ error: { code: "GRANT_STALE" } });

    const receipt = claim.data?.receipt as { claimId: string };
    const resultRequest = {
      context: context({ requestId: "req_replay_result", correlationId: "cor_replay_result", pairingGeneration: 4, grantRevision: 7 }),
      method: "POST" as const,
      target: "/open-android-intelligence/v2/device-requests/device_req_replay_binding/result",
      idempotencyKey: "req_replay_result",
      body: {
        claimId: receipt.claimId,
        grantRevision: 7,
        result: { outcome: "succeeded", data: { ok: true } },
      },
      now: new Date("2026-08-27T00:02:00.000Z"),
    };
    const result = await core.handle(resultRequest);
    expect(result.data?.deviceRequest).toBeDefined();
    await expect(core.handle({
      ...resultRequest,
      context: { ...resultRequest.context, pairingGeneration: 5 },
    })).resolves.toMatchObject({ error: { code: "PAIRING_GENERATION_STALE" } });
  });

  it("uses the injected clock for claim expiration at the GatewayCore entry", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    account.deviceRequests.enqueue({
      requestId: "device_req_handle_expiry",
      deviceId: "dev_1",
      pairingGeneration: 2,
      grantRevision: 3,
      risk: "write",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: {},
      correlationId: "cor_handle_expiry_enqueue",
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    account.close();

    await expect(core.handle({
      context: context({ requestId: "req_handle_expiry", correlationId: "cor_handle_expiry", pairingGeneration: 2, grantRevision: 3 }),
      method: "POST",
      target: "/open-android-intelligence/v2/device-requests/device_req_handle_expiry/claim",
      idempotencyKey: "req_handle_expiry",
      now: new Date("2030-01-01T00:16:00.000Z"),
    })).resolves.toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });

    const reopened = await core.openGatewayAccount("acct_alice");
    expect(reopened.deviceRequests.get("device_req_handle_expiry").state).toBe("expired");
    reopened.close();
  });

  it("replays a known terminal device result after the device request TTL", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    account.deviceRequests.enqueue({
      requestId: "device_req_terminal_replay",
      deviceId: "dev_1",
      pairingGeneration: 2,
      grantRevision: 3,
      risk: "read",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: {},
      correlationId: "cor_terminal_replay_enqueue",
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    account.close();

    const claim = await core.handle({
      context: context({ requestId: "req_terminal_claim", correlationId: "cor_terminal_claim", pairingGeneration: 2, grantRevision: 3 }),
      method: "POST",
      target: "/open-android-intelligence/v2/device-requests/device_req_terminal_replay/claim",
      idempotencyKey: "req_terminal_claim",
      now: new Date("2026-08-27T00:01:00.000Z"),
    });
    const receipt = claim.data?.receipt as { claimId: string };
    const resultRequest = {
      context: context({ requestId: "req_terminal_result", correlationId: "cor_terminal_result", pairingGeneration: 2, grantRevision: 3 }),
      method: "POST" as const,
      target: "/open-android-intelligence/v2/device-requests/device_req_terminal_replay/result",
      idempotencyKey: "req_terminal_result",
      body: {
        claimId: receipt.claimId,
        grantRevision: 3,
        result: { outcome: "succeeded", data: { ok: true } },
      },
      now: new Date("2026-08-27T00:02:00.000Z"),
    };
    const first = await core.handle(resultRequest);
    expect(first.data?.deviceRequest).toBeDefined();

    await expect(core.handle({
      ...resultRequest,
      now: new Date("2026-08-28T00:01:00.000Z"),
    })).resolves.toEqual(first);
  });

  it("rolls back handle side effects when the idempotency ledger cannot persist the terminal outcome", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    account.store.database.exec(`
      CREATE TRIGGER fail_idempotency_insert
      BEFORE INSERT ON idempotency_ledger
      BEGIN
        SELECT RAISE(ABORT, 'ledger forced failure');
      END;
    `);
    account.close();

    await expect(core.handle({
      context: context({ requestId: "req_atomic", correlationId: "cor_atomic" }),
      method: "POST",
      target: "/open-android-intelligence/v2/conversations",
      idempotencyKey: "req_atomic",
      body: { clientConversationId: "conv_client_atomic", title: "Atomic thread" },
      now: new Date("2026-08-27T00:00:00.000Z"),
    })).resolves.toHaveProperty("error");

    const reopened = await core.openGatewayAccount("acct_alice");
    const count = (reopened.store.database
      .prepare("SELECT COUNT(*) AS count FROM conversations WHERE client_conversation_id = ?")
      .get("conv_client_atomic") as { count: number }).count;
    expect(count).toBe(0);
    reopened.close();
  });

  it("rolls back business writes and does not ledger an unexpected work failure", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    account.store.database.exec(`
      CREATE TRIGGER fail_conversation_audit
      BEFORE INSERT ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit forced failure');
      END;
    `);
    account.close();

    await expect(core.handle({
      context: context({ requestId: "req_unexpected_work", correlationId: "cor_unexpected_work" }),
      method: "POST",
      target: "/open-android-intelligence/v2/conversations",
      idempotencyKey: "req_unexpected_work",
      body: { clientConversationId: "conv_client_unexpected_work", title: "Should roll back" },
      now: new Date("2026-08-27T00:00:00.000Z"),
    })).resolves.toMatchObject({ error: { code: "INTERNAL_ERROR" } });

    const reopened = await core.openGatewayAccount("acct_alice");
    const conversationCount = (reopened.store.database
      .prepare("SELECT COUNT(*) AS count FROM conversations WHERE client_conversation_id = ?")
      .get("conv_client_unexpected_work") as { count: number }).count;
    const ledgerCount = (reopened.store.database
      .prepare("SELECT COUNT(*) AS count FROM idempotency_ledger WHERE device_id = ? AND request_id = ?")
      .get("dev_1", "req_unexpected_work") as { count: number }).count;
    expect(conversationCount).toBe(0);
    expect(ledgerCount).toBe(0);
    reopened.close();
  });
});
