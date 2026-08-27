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
    return this.store.transaction(() => {
      const existing = this.store.database
        .prepare("SELECT * FROM claim_receipts WHERE request_id = ?")
        .get(input.requestId) as Record<string, unknown> | undefined;
      if (existing !== undefined) return this.mapReceipt(existing);

      const request = this.getRow(input.requestId);
      this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
      const state = String(request.state) as DeviceRequestState;
      if (state !== "pending") throw new Error("OUTCOME_UNKNOWN");
      this.store.database
        .prepare("UPDATE device_requests SET state = ? WHERE request_id = ?")
        .run(nextDeviceRequestState(state, "claim"), input.requestId);
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
      return Object.freeze({
        claimId,
        requestId: input.requestId,
        accountId: this.accountId,
        deviceId: input.deviceId,
        pairingGeneration: input.pairingGeneration,
        grantRevision: input.grantRevision,
      });
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
    return this.store.transaction(() => {
      const request = this.getRow(input.requestId);
      this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
      const receipt = this.store.database
        .prepare("SELECT * FROM claim_receipts WHERE request_id = ? AND claim_id = ?")
        .get(input.requestId, input.claimId) as Record<string, unknown> | undefined;
      if (receipt === undefined) throw new Error("OUTCOME_UNKNOWN");
      this.assertBinding(receipt, input.deviceId, input.pairingGeneration, input.grantRevision);

      const state = String(request.state) as DeviceRequestState;
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
      Number(row.pairing_generation) !== pairingGeneration ||
      Number(row.grant_revision) !== grantRevision
    ) {
      throw new Error("PAIRING_GENERATION_STALE");
    }
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
