import { randomUUID } from "node:crypto";

import {
  maximumDeviceRequestQueueSeconds,
  nextDeviceRequestState,
  type DeviceRequestRisk,
  type DeviceRequestState,
} from "../../../../gateway-contract/src/state-machines.js";
import type { GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";
import { EventStore } from "./event-store.js";

export type ClaimReceipt = Readonly<{
  claimId: string;
  requestId: string;
  accountId: string;
  deviceId: string;
  pairingGeneration: number;
  grantRevision: number;
}>;

export type DeviceRequestRecord = Readonly<{
  requestId: string;
  deviceId: string;
  pairingGeneration: number;
  grantRevision: number;
  risk: DeviceRequestRisk;
  state: DeviceRequestState;
  expiresAt: string;
}>;

type ResultOutcome = "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown";
type ClaimTransactionResult = Readonly<
  | { kind: "expired" }
  | { kind: "receipt"; receipt: ClaimReceipt }
>;

export class DeviceRequestStore {
  constructor(
    private readonly accountId: string,
    private readonly store: GatewayAccountStore,
    private readonly audit: AuditStore,
    private readonly events: EventStore,
  ) {}

  enqueue(input: Readonly<{
    requestId: string;
    deviceId: string;
    pairingGeneration: number;
    grantRevision: number;
    risk: DeviceRequestRisk;
    capability: Readonly<Record<string, unknown>>;
    provider: Readonly<Record<string, unknown>>;
    parameters: Readonly<Record<string, unknown>>;
    correlationId: string;
    now?: Date;
  }>): DeviceRequestRecord {
    const now = input.now ?? new Date();
    const ttlSeconds = maximumDeviceRequestQueueSeconds(input.risk);
    const state: DeviceRequestState = ttlSeconds === 0 ? "expired" : "pending";
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    this.store.database
      .prepare(`
        INSERT INTO device_requests(
          request_id, device_id, pairing_generation, grant_revision, risk, state,
          capability_json, provider_json, parameters_json, created_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.requestId,
        input.deviceId,
        input.pairingGeneration,
        input.grantRevision,
        input.risk,
        state,
        JSON.stringify(input.capability),
        JSON.stringify(input.provider),
        JSON.stringify(input.parameters),
        now.toISOString(),
        expiresAt,
      );
    if (state === "pending") {
      this.events.append({
        eventType: "device.requested",
        correlationId: input.correlationId,
        payload: { requestId: input.requestId, risk: input.risk, grantRevision: input.grantRevision },
        now,
      });
    }
    return this.get(input.requestId);
  }

  claim(input: Readonly<{
    requestId: string;
    deviceId: string;
    pairingGeneration: number;
    grantRevision: number;
    correlationId: string;
    now?: Date;
  }>): ClaimReceipt {
    const outcome = this.store.transaction<ClaimTransactionResult>(() => {
      const request = this.getRow(input.requestId);
      this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
      if (this.expireIfDue(request, input.now ?? new Date())) return { kind: "expired" };

      const existing = this.store.database
        .prepare("SELECT * FROM claim_receipts WHERE request_id = ?")
        .get(input.requestId) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        this.assertBinding(existing, input.deviceId, input.pairingGeneration, input.grantRevision);
        return { kind: "receipt", receipt: this.mapReceipt(existing) };
      }

      const state = String(request.state) as DeviceRequestState;
      if (state !== "pending") throw new Error("OUTCOME_UNKNOWN");
      const claimed = this.store.database
        .prepare(`
          UPDATE device_requests
          SET state = ?
          WHERE request_id = ?
            AND state = 'pending'
            AND device_id = ?
            AND pairing_generation = ?
            AND grant_revision = ?
        `)
        .run(
          nextDeviceRequestState(state, "claim"),
          input.requestId,
          input.deviceId,
          input.pairingGeneration,
          input.grantRevision,
        ) as { changes: number };
      if (claimed.changes !== 1) throw new Error("OUTCOME_UNKNOWN");
      const claimId = `claim_${randomUUID()}`;
      this.store.database
        .prepare(`
          INSERT INTO claim_receipts(
            claim_id, request_id, device_id, pairing_generation, grant_revision, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          claimId,
          input.requestId,
          input.deviceId,
          input.pairingGeneration,
          input.grantRevision,
          (input.now ?? new Date()).toISOString(),
        );
      this.audit.append({
        eventType: "device.request.claimed",
        actor: { accountId: this.accountId, deviceId: input.deviceId },
        subject: { requestId: input.requestId, claimId, grantRevision: input.grantRevision },
        correlationId: input.correlationId,
        occurredAt: (input.now ?? new Date()).toISOString(),
      });
      return {
        kind: "receipt",
        receipt: Object.freeze({
          claimId,
          requestId: input.requestId,
          accountId: this.accountId,
          deviceId: input.deviceId,
          pairingGeneration: input.pairingGeneration,
          grantRevision: input.grantRevision,
        }),
      };
    });
    if (outcome.kind === "expired") throw new Error("OUTCOME_UNKNOWN");
    return outcome.receipt;
  }

  validateClaimReplay(input: Readonly<{
    requestId: string;
    deviceId: string;
    pairingGeneration: number;
    grantRevision: number;
    now?: Date;
  }>): "OUTCOME_UNKNOWN" | undefined {
    return this.store.transaction(() => {
      const request = this.getRow(input.requestId);
      this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
      if (this.expireIfDue(request, input.now ?? new Date())) return "OUTCOME_UNKNOWN";
      const receipt = this.store.database
        .prepare("SELECT * FROM claim_receipts WHERE request_id = ?")
        .get(input.requestId) as Record<string, unknown> | undefined;
      if (receipt === undefined) throw new Error("OUTCOME_UNKNOWN");
      this.assertBinding(receipt, input.deviceId, input.pairingGeneration, input.grantRevision);
      return undefined;
    });
  }

  submitResult(input: Readonly<{
    requestId: string;
    deviceId: string;
    pairingGeneration: number;
    grantRevision: number;
    claimId: string;
    result: Readonly<{ outcome: ResultOutcome; data?: Readonly<Record<string, unknown>> }>;
    correlationId: string;
    now?: Date;
  }>): DeviceRequestRecord {
    const outcome = this.store.transaction<DeviceRequestRecord | "OUTCOME_UNKNOWN">(() => {
      const request = this.getRow(input.requestId);
      this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
      if (this.expireIfDue(request, input.now ?? new Date())) return "OUTCOME_UNKNOWN";
      const receipt = this.store.database
        .prepare("SELECT * FROM claim_receipts WHERE request_id = ? AND claim_id = ?")
        .get(input.requestId, input.claimId) as Record<string, unknown> | undefined;
      if (receipt === undefined) throw new Error("OUTCOME_UNKNOWN");
      this.assertBinding(receipt, input.deviceId, input.pairingGeneration, input.grantRevision);

      const state = String(request.state) as DeviceRequestState;
      if (state !== "claimed" && state !== "cancel_requested") return "OUTCOME_UNKNOWN";
      const event = `result_${input.result.outcome}` as const;
      const next = input.result.outcome === "outcome_unknown"
        ? nextDeviceRequestState(state, "result_outcome_unknown")
        : nextDeviceRequestState(state, event);
      this.store.database
        .prepare("UPDATE device_requests SET state = ? WHERE request_id = ?")
        .run(next, input.requestId);
      this.audit.append({
        eventType: "device.request.result",
        actor: { accountId: this.accountId, deviceId: input.deviceId },
        subject: { requestId: input.requestId, claimId: input.claimId, outcome: input.result.outcome },
        correlationId: input.correlationId,
        occurredAt: (input.now ?? new Date()).toISOString(),
      });
      return this.get(input.requestId);
    });
    if (outcome === "OUTCOME_UNKNOWN") throw new Error(outcome);
    return outcome;
  }

  validateResultReplay(input: Readonly<{
    requestId: string;
    deviceId: string;
    pairingGeneration: number;
    grantRevision: number;
    claimId: string;
    now?: Date;
  }>): "OUTCOME_UNKNOWN" | undefined {
    return this.store.transaction(() => {
      const request = this.getRow(input.requestId);
      this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
      if (this.expireIfDue(request, input.now ?? new Date())) return "OUTCOME_UNKNOWN";
      const receipt = this.store.database
        .prepare("SELECT * FROM claim_receipts WHERE request_id = ? AND claim_id = ?")
        .get(input.requestId, input.claimId) as Record<string, unknown> | undefined;
      if (receipt === undefined) throw new Error("OUTCOME_UNKNOWN");
      this.assertBinding(receipt, input.deviceId, input.pairingGeneration, input.grantRevision);
      return undefined;
    });
  }

  recoverExpired(now = new Date()): number {
    let recovered = 0;
    const rows = this.store.database
      .prepare("SELECT * FROM device_requests WHERE expires_at <= ? AND state IN ('pending', 'claimed', 'cancel_requested')")
      .all(now.toISOString()) as Record<string, unknown>[];
    for (const row of rows) {
      this.store.transaction(() => {
        const state = String(row.state) as DeviceRequestState;
        const event = state === "pending" ? "expire" : "recover_outcome_unknown";
        this.store.database
          .prepare("UPDATE device_requests SET state = ? WHERE request_id = ?")
          .run(nextDeviceRequestState(state, event), String(row.request_id));
        recovered += 1;
      });
    }
    return recovered;
  }

  get(requestId: string): DeviceRequestRecord {
    return this.mapRequest(this.getRow(requestId));
  }

  private getRow(requestId: string): Record<string, unknown> {
    const row = this.store.database
      .prepare("SELECT * FROM device_requests WHERE request_id = ?")
      .get(requestId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("OUTCOME_UNKNOWN");
    return row;
  }

  private assertBinding(
    row: Record<string, unknown>,
    deviceId: string,
    pairingGeneration: number,
    grantRevision: number,
  ): void {
    if (
      String(row.device_id) !== deviceId ||
      Number(row.pairing_generation) !== pairingGeneration
    ) {
      throw new Error("PAIRING_GENERATION_STALE");
    }
    if (Number(row.grant_revision) !== grantRevision) throw new Error("GRANT_STALE");
  }

  private expireIfDue(row: Record<string, unknown>, now: Date): boolean {
    if (Date.parse(String(row.expires_at)) > now.getTime()) return false;
    const state = String(row.state) as DeviceRequestState;
    if (state !== "pending" && state !== "claimed" && state !== "cancel_requested") return false;
    const event = state === "pending" ? "expire" : "recover_outcome_unknown";
    this.store.database
      .prepare("UPDATE device_requests SET state = ? WHERE request_id = ?")
      .run(nextDeviceRequestState(state, event), String(row.request_id));
    return true;
  }

  private mapRequest(row: Record<string, unknown>): DeviceRequestRecord {
    return Object.freeze({
      requestId: String(row.request_id),
      deviceId: String(row.device_id),
      pairingGeneration: Number(row.pairing_generation),
      grantRevision: Number(row.grant_revision),
      risk: String(row.risk) as DeviceRequestRisk,
      state: String(row.state) as DeviceRequestState,
      expiresAt: String(row.expires_at),
    });
  }

  private mapReceipt(row: Record<string, unknown>): ClaimReceipt {
    return Object.freeze({
      claimId: String(row.claim_id),
      requestId: String(row.request_id),
      accountId: this.accountId,
      deviceId: String(row.device_id),
      pairingGeneration: Number(row.pairing_generation),
      grantRevision: Number(row.grant_revision),
    });
  }
}
