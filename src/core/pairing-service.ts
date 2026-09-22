import type { GatewayAccountStore } from "./account-store.js";
import type { AttachmentStore } from "./attachment-store.js";
import { AuditStore } from "./audit-store.js";
import type { DeviceRequestStore } from "./device-request-store.js";
import type { SessionService } from "./session-service.js";

/**
 * The response body of `DELETE /pairings/current` (contract §5.6, `$defs/unpair`).
 *
 * Every flag is an observed post-condition, not a claim: after the transaction
 * the service re-reads the store and reports whether anything of that class
 * still exists. A flag is therefore never `true` because the code "intended" to
 * revoke something — it is `true` only because the store now proves it is gone.
 */
export type UnpairReceipt = Readonly<{
  deviceId: string;
  deviceKeysRevoked: boolean;
  refreshRevoked: boolean;
  grantsRevoked: boolean;
  deviceRequestsRevoked: boolean;
  unconfirmedAttachmentsRevoked: boolean;
  sessionsRevoked: boolean;
}>;

export type UnpairOutcome = Readonly<{
  receipt: UnpairReceipt;
  pairingGeneration: number;
  revoked: Readonly<{
    sessions: number;
    deviceRequests: number;
    attachments: number;
  }>;
}>;

/**
 * 解除配对 for one device of one account.
 *
 * Contract §13 names the five resource classes 解除配对 revokes — device keys,
 * refresh credential, grants, queue and unconfirmed attachments — and the Wave 0
 * ruling D1 adds every access session of the device plus a `pairingGeneration`
 * bump. This is a resource-level transaction: it is never expressed as
 * per-attachment or per-request state jumps, because neither state machine has a
 * "revoked" state to jump to.
 */
export class PairingService {
  constructor(
    private readonly accountId: string,
    private readonly store: GatewayAccountStore,
    private readonly audit: AuditStore,
    private readonly sessions: SessionService,
    private readonly deviceRequests: DeviceRequestStore,
    private readonly attachments: AttachmentStore,
  ) {}

  hasActivePairing(deviceId: string): boolean {
    const row = this.store.database
      .prepare("SELECT 1 AS present FROM device_keys WHERE device_id = ?")
      .get(deviceId) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  revoke(input: Readonly<{
    deviceId: string;
    correlationId: string;
    now?: Date;
  }>): UnpairOutcome {
    const now = input.now ?? new Date();
    return this.store.transaction(() => {
      const deviceId = input.deviceId;
      const key = this.store.database
        .prepare("SELECT pairing_generation AS pairing_generation, grant_revision AS grant_revision FROM device_keys WHERE device_id = ?")
        .get(deviceId) as Record<string, unknown> | undefined;
      // No key means there is no pairing to unpaired: the request is refused
      // rather than silently "succeeding" against nothing, so a caller cannot
      // mistake an already-unpaired device for a freshly revoked one.
      if (key === undefined) throw new Error("PAIRING_REQUIRED");

      const previousGrantRevision = Number(key.grant_revision ?? 1);

      // 1. Device key: the Ed25519 public key the device signs with. Without it
      // no later request of this pairing can be verified.
      this.store.database.prepare("DELETE FROM device_keys WHERE device_id = ?").run(deviceId);

      // 2. Refresh credential: the device can no longer mint an access token.
      this.sessions.revokeRefreshCredentials(deviceId, input.correlationId, now);

      // 3. Grants. This host stores no grant table: the per-device grant state
      // is the `grant_revision` carried by the device key, so no key row
      // surviving is also no grant surviving (see 3-6 for the store that gives
      // grants a table of their own — it must be swept here too).
      const deviceRequests = this.deviceRequests.revokeForDevice({
        deviceId,
        correlationId: input.correlationId,
        now,
      });

      // 4. Unconfirmed attachments and their staged bytes.
      const attachments = this.attachments.revokeUnconfirmed({
        correlationId: input.correlationId,
        now,
      });

      // 5. Every access session of the device, not only the caller's.
      const sessions = this.sessions.revokeDeviceSessions(deviceId, input.correlationId, now);

      const pairingGeneration = this.bumpPairingGeneration();

      const receipt: UnpairReceipt = Object.freeze({
        deviceId,
        deviceKeysRevoked: !this.hasActivePairing(deviceId),
        refreshRevoked: this.sessions.activeRefreshCredentialCount(deviceId) === 0,
        grantsRevoked: !this.hasActivePairing(deviceId),
        deviceRequestsRevoked: this.deviceRequests.countLiveForDevice(deviceId) === 0,
        unconfirmedAttachmentsRevoked: this.attachments.countUnconfirmed() === 0,
        sessionsRevoked: this.sessions.activeSessionCount(deviceId) === 0,
      });

      this.audit.append({
        eventType: "pairing.revoked",
        actor: { accountId: this.accountId, deviceId },
        subject: {
          previousGrantRevision,
          pairingGeneration,
          sessions,
          deviceRequests,
          attachments,
          ...receipt,
        },
        correlationId: input.correlationId,
        occurredAt: now.toISOString(),
      });

      return Object.freeze({
        receipt,
        pairingGeneration,
        revoked: Object.freeze({ sessions, deviceRequests, attachments }),
      });
    });
  }

  /**
   * Contract §12: the generation only ever moves up, and it survives the device
   * key it seeds so the next re-pair starts above the revoked generation.
   */
  private bumpPairingGeneration(): number {
    const next = this.sessions.currentPairingGeneration() + 1;
    this.store.database
      .prepare("UPDATE account_metadata SET value = ? WHERE key = 'pairing_generation'")
      .run(String(next));
    return next;
  }
}
