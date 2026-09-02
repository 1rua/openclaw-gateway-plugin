import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "open-android-intelligence-openclaw-device-"));

describe("OpenClaw Gateway device request queue", () => {
  it("binds claim/result to account, device, generation and grant revision across recovery", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const alice = await core.openGatewayAccount("acct_alice");
    const bob = await core.openGatewayAccount("acct_bob");

    const read = alice.deviceRequests.enqueue({
      requestId: "device_req_read",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      risk: "read",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: { limit: 1 },
      correlationId: "cor_device_read",
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    const write = alice.deviceRequests.enqueue({
      requestId: "device_req_write",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      risk: "write",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: {},
      correlationId: "cor_device_write",
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    const high = alice.deviceRequests.enqueue({
      requestId: "device_req_high",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      risk: "high-privilege-ephemeral",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
      provider: {
        pluginId: "org.openandroidintelligence.sms",
        authorKeyId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      parameters: {},
      correlationId: "cor_device_high",
      now: new Date("2026-08-24T12:00:00.000Z"),
    });

    expect(read.expiresAt).toBe("2026-08-25T12:00:00.000Z");
    expect(write.expiresAt).toBe("2026-08-24T12:15:00.000Z");
    expect(high.state).toBe("expired");

    expect(() =>
      alice.deviceRequests.submitResult({
        requestId: "device_req_read",
        deviceId: "dev_1",
        pairingGeneration: 4,
        grantRevision: 7,
        claimId: "claim_missing",
        result: { outcome: "succeeded", data: { ok: true } },
        correlationId: "cor_unclaimed",
        now: new Date("2026-08-24T12:01:00.000Z"),
      }),
    ).toThrowError("OUTCOME_UNKNOWN");

    const claim = alice.deviceRequests.claim({
      requestId: "device_req_read",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      correlationId: "cor_claim",
      now: new Date("2026-08-24T12:02:00.000Z"),
    });
    expect(alice.deviceRequests.claim({
      requestId: "device_req_read",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      correlationId: "cor_claim_retry",
      now: new Date("2026-08-24T12:03:00.000Z"),
    })).toEqual(claim);
    expect(() =>
      alice.deviceRequests.claim({
        requestId: "device_req_read",
        deviceId: "dev_2",
        pairingGeneration: 4,
        grantRevision: 7,
        correlationId: "cor_claim_wrong_device",
        now: new Date("2026-08-24T12:04:00.000Z"),
      }),
    ).toThrowError("PAIRING_GENERATION_STALE");
    expect(() =>
      alice.deviceRequests.claim({
        requestId: "device_req_read",
        deviceId: "dev_1",
        pairingGeneration: 4,
        grantRevision: 8,
        correlationId: "cor_claim_wrong_grant",
        now: new Date("2026-08-24T12:04:00.000Z"),
      }),
    ).toThrowError("GRANT_STALE");
    expect(() =>
      alice.deviceRequests.submitResult({
        requestId: "device_req_read",
        deviceId: "dev_2",
        pairingGeneration: 4,
        grantRevision: 7,
        claimId: claim.claimId,
        result: { outcome: "succeeded", data: { ok: true } },
        correlationId: "cor_wrong_device",
        now: new Date("2026-08-24T12:04:00.000Z"),
      }),
    ).toThrowError("PAIRING_GENERATION_STALE");
    expect(() =>
      bob.deviceRequests.submitResult({
        requestId: "device_req_read",
        deviceId: "dev_1",
        pairingGeneration: 4,
        grantRevision: 7,
        claimId: claim.claimId,
        result: { outcome: "succeeded", data: { ok: true } },
        correlationId: "cor_cross_account",
        now: new Date("2026-08-24T12:04:00.000Z"),
      }),
    ).toThrowError("OUTCOME_UNKNOWN");

    const result = alice.deviceRequests.submitResult({
      requestId: "device_req_read",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      claimId: claim.claimId,
      result: { outcome: "succeeded", data: { ok: true } },
      correlationId: "cor_result",
      now: new Date("2026-08-24T12:05:00.000Z"),
    });
    expect(result.state).toBe("succeeded");

    alice.deviceRequests.claim({
      requestId: "device_req_write",
      deviceId: "dev_1",
      pairingGeneration: 4,
      grantRevision: 7,
      correlationId: "cor_claim_write",
      now: new Date("2026-08-24T12:05:00.000Z"),
    });
    alice.close();
    const reopened = await createGatewayCore({ storageRoot }).openGatewayAccount("acct_alice");
    reopened.deviceRequests.recoverExpired(new Date("2026-08-24T12:16:00.000Z"));
    expect(reopened.deviceRequests.get("device_req_write").state).toBe("outcome_unknown");

    reopened.close();
    bob.close();
  });

  it("expires pending and claimed requests at claim/result entry without relying on manual recovery", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const alice = await core.openGatewayAccount("acct_alice");

    alice.deviceRequests.enqueue({
      requestId: "device_req_expired_pending",
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
      correlationId: "cor_expired_pending",
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    expect(() =>
      alice.deviceRequests.claim({
        requestId: "device_req_expired_pending",
        deviceId: "dev_1",
        pairingGeneration: 2,
        grantRevision: 3,
        correlationId: "cor_late_claim",
        now: new Date("2026-08-27T00:16:00.000Z"),
      }),
    ).toThrowError("OUTCOME_UNKNOWN");
    expect(alice.deviceRequests.get("device_req_expired_pending").state).toBe("expired");

    alice.deviceRequests.enqueue({
      requestId: "device_req_expired_claimed",
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
      correlationId: "cor_claimed",
      now: new Date("2026-08-27T01:00:00.000Z"),
    });
    const claim = alice.deviceRequests.claim({
      requestId: "device_req_expired_claimed",
      deviceId: "dev_1",
      pairingGeneration: 2,
      grantRevision: 3,
      correlationId: "cor_claimed_claim",
      now: new Date("2026-08-27T01:01:00.000Z"),
    });
    expect(() =>
      alice.deviceRequests.submitResult({
        requestId: "device_req_expired_claimed",
        deviceId: "dev_1",
        pairingGeneration: 2,
        grantRevision: 3,
        claimId: claim.claimId,
        result: { outcome: "succeeded", data: { ok: true } },
        correlationId: "cor_late_result",
        now: new Date("2026-08-27T01:16:00.000Z"),
      }),
    ).toThrowError("OUTCOME_UNKNOWN");
    expect(alice.deviceRequests.get("device_req_expired_claimed").state).toBe("outcome_unknown");

    alice.close();
  });
});
