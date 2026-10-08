import { randomUUID } from "node:crypto";
import { maximumDeviceRequestQueueSeconds, nextDeviceRequestState, } from "../../gateway-contract/src/state-machines.js";
import { CapabilityBindings } from "./capability-bindings.js";
export class DeviceRequestStore {
    accountId;
    store;
    audit;
    events;
    capabilities;
    constructor(accountId, store, audit, events) {
        this.accountId = accountId;
        this.store = store;
        this.audit = audit;
        this.events = events;
        this.capabilities = new CapabilityBindings(store);
    }
    enqueue(input) {
        const now = input.now ?? new Date();
        const ttlSeconds = maximumDeviceRequestQueueSeconds(input.risk);
        const state = ttlSeconds === 0 && !input.online ? "expired" : "pending";
        // Zero is the offline queue allowance, not an online execution lease.
        const expiresAt = new Date(now.getTime() + (ttlSeconds || (input.online ? 30 : 0)) * 1000).toISOString();
        const payload = {
            requestId: input.requestId, capability: input.capability, provider: input.provider,
            parameters: input.parameters, risk: input.risk, grantRevision: input.grantRevision,
            createdAt: now.toISOString(), expiresAt,
            requiresForegroundConfirmation: input.risk === "high-privilege-ephemeral" || (input.requiresForegroundConfirmation ?? false),
        };
        if (!this.capabilities.validate(input.deviceId, input.pairingGeneration, input.grantRevision, payload))
            throw new Error("SCHEMA_INVALID");
        return this.store.transaction(() => {
            this.store.database
                .prepare(`
        INSERT INTO device_requests(
          request_id, device_id, pairing_generation, grant_revision, risk, state,
          capability_json, provider_json, parameters_json, created_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
                .run(input.requestId, input.deviceId, input.pairingGeneration, input.grantRevision, input.risk, state, JSON.stringify(input.capability), JSON.stringify(input.provider), state === "pending" ? this.store.sealJson(input.parameters, `device-request:${input.requestId}`) : "", now.toISOString(), expiresAt);
            if (state === "pending") {
                this.events.append({
                    eventType: "device.requested",
                    correlationId: input.correlationId,
                    payload,
                    now,
                });
            }
            return this.get(input.requestId);
        });
    }
    claim(input) {
        const outcome = this.store.transaction(() => {
            const request = this.getRow(input.requestId);
            this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
            if (this.expireIfDue(request, input.now ?? new Date()))
                return { kind: "expired" };
            const existing = this.store.database
                .prepare("SELECT * FROM claim_receipts WHERE request_id = ?")
                .get(input.requestId);
            if (existing !== undefined) {
                this.assertBinding(existing, input.deviceId, input.pairingGeneration, input.grantRevision);
                return { kind: "receipt", receipt: this.mapReceipt(existing) };
            }
            const state = String(request.state);
            if (state !== "pending")
                throw new Error("OUTCOME_UNKNOWN");
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
                .run(nextDeviceRequestState(state, "claim"), input.requestId, input.deviceId, input.pairingGeneration, input.grantRevision);
            if (claimed.changes !== 1)
                throw new Error("OUTCOME_UNKNOWN");
            const claimId = `claim_${randomUUID()}`;
            this.store.database
                .prepare(`
          INSERT INTO claim_receipts(
            claim_id, request_id, device_id, pairing_generation, grant_revision, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `)
                .run(claimId, input.requestId, input.deviceId, input.pairingGeneration, input.grantRevision, (input.now ?? new Date()).toISOString());
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
        if (outcome.kind === "expired")
            throw new Error("OUTCOME_UNKNOWN");
        return outcome.receipt;
    }
    validateClaimReplay(input) {
        return this.store.transaction(() => {
            const request = this.getRow(input.requestId);
            this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
            if (this.expireIfDue(request, input.now ?? new Date()))
                return "OUTCOME_UNKNOWN";
            const receipt = this.store.database
                .prepare("SELECT * FROM claim_receipts WHERE request_id = ?")
                .get(input.requestId);
            if (receipt === undefined)
                throw new Error("OUTCOME_UNKNOWN");
            this.assertBinding(receipt, input.deviceId, input.pairingGeneration, input.grantRevision);
            return undefined;
        });
    }
    submitResult(input) {
        const outcome = this.store.transaction(() => {
            const request = this.getRow(input.requestId);
            this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
            if (this.expireIfDue(request, input.now ?? new Date()))
                return "OUTCOME_UNKNOWN";
            const receipt = this.store.database
                .prepare("SELECT * FROM claim_receipts WHERE request_id = ? AND claim_id = ?")
                .get(input.requestId, input.claimId);
            if (receipt === undefined)
                throw new Error("OUTCOME_UNKNOWN");
            this.assertBinding(receipt, input.deviceId, input.pairingGeneration, input.grantRevision);
            const state = String(request.state);
            if (state !== "claimed" && state !== "cancel_requested")
                return "OUTCOME_UNKNOWN";
            const event = `result_${input.result.outcome}`;
            const next = input.result.outcome === "outcome_unknown"
                ? nextDeviceRequestState(state, "result_outcome_unknown")
                : nextDeviceRequestState(state, event);
            this.store.database
                .prepare("UPDATE device_requests SET state = ?, parameters_json = '', result_json = ? WHERE request_id = ?")
                .run(next, this.store.sealJson(input.result, `device-result:${input.requestId}:${input.claimId}`), input.requestId);
            this.events.releaseDeviceRequest(input.requestId);
            this.audit.append({
                eventType: "device.request.result",
                actor: { accountId: this.accountId, deviceId: input.deviceId },
                subject: { requestId: input.requestId, claimId: input.claimId, outcome: input.result.outcome },
                correlationId: input.correlationId,
                occurredAt: (input.now ?? new Date()).toISOString(),
            });
            return this.get(input.requestId);
        });
        if (outcome === "OUTCOME_UNKNOWN")
            throw new Error(outcome);
        return outcome;
    }
    validateResultReplay(input) {
        return this.store.transaction(() => {
            const request = this.getRow(input.requestId);
            this.assertBinding(request, input.deviceId, input.pairingGeneration, input.grantRevision);
            if (this.expireIfDue(request, input.now ?? new Date()))
                return "OUTCOME_UNKNOWN";
            const receipt = this.store.database
                .prepare("SELECT * FROM claim_receipts WHERE request_id = ? AND claim_id = ?")
                .get(input.requestId, input.claimId);
            if (receipt === undefined)
                throw new Error("OUTCOME_UNKNOWN");
            this.assertBinding(receipt, input.deviceId, input.pairingGeneration, input.grantRevision);
            return undefined;
        });
    }
    /**
     * 解除配对: takes every live request of one device out of the queue (§13).
     *
     * Only the documented `cancel` transition is used, so a request the device had
     * already claimed becomes `cancel_requested` rather than a fabricated outcome.
     * What finishes the job is the caller's `pairingGeneration` bump: every row
     * left behind is bound to a generation the device can no longer present, so it
     * can never be claimed or answered (§12, `PAIRING_GENERATION_STALE`).
     */
    cancel(input) {
        const outcome = this.store.transaction(() => {
            const row = this.getRow(input.requestId);
            this.assertBinding(row, input.deviceId, input.pairingGeneration, input.grantRevision);
            if (this.expireIfDue(row, input.now ?? new Date()))
                return "OUTCOME_UNKNOWN";
            if (row.state === "cancelled" || row.state === "cancel_requested")
                return this.get(input.requestId);
            const state = nextDeviceRequestState(String(row.state), "cancel");
            this.store.database.prepare("UPDATE device_requests SET state=?,parameters_json=CASE WHEN ?='cancelled' THEN '' ELSE parameters_json END WHERE request_id=?")
                .run(state, state, input.requestId);
            if (state === "cancelled")
                this.events.releaseDeviceRequest(input.requestId);
            this.events.append({ eventType: "device.request.cancel.requested", correlationId: input.correlationId, payload: { requestId: input.requestId }, now: input.now });
            return this.get(input.requestId);
        });
        if (outcome === "OUTCOME_UNKNOWN")
            throw new Error(outcome);
        return outcome;
    }
    revokeForDevice(input) {
        const now = input.now ?? new Date();
        return this.store.transaction(() => {
            const rows = this.store.database
                .prepare(`
          SELECT request_id AS request_id, state AS state FROM device_requests
          WHERE device_id = ? AND state IN ('pending', 'claimed', 'cancel_requested')
        `)
                .all(input.deviceId);
            for (const row of rows) {
                const requestId = String(row.request_id);
                const state = String(row.state);
                this.store.database
                    .prepare("UPDATE device_requests SET state = ?, parameters_json = '' WHERE request_id = ?")
                    .run(nextDeviceRequestState(state, "cancel"), requestId);
                this.events.append({
                    eventType: "device.request.cancel.requested",
                    correlationId: input.correlationId,
                    payload: { requestId },
                    now,
                });
            }
            return rows.length;
        });
    }
    /** Requests still answerable by the device: the queue §13 has to empty. */
    countLiveForDevice(deviceId) {
        const row = this.store.database
            .prepare(`
        SELECT COUNT(*) AS count FROM device_requests
        WHERE device_id = ? AND state IN ('pending', 'claimed', 'cancel_requested')
      `)
            .get(deviceId);
        return row.count;
    }
    recoverExpired(now = new Date()) {
        let recovered = 0;
        const rows = this.store.database
            .prepare("SELECT * FROM device_requests WHERE expires_at <= ? AND state IN ('pending', 'claimed', 'cancel_requested') ORDER BY expires_at LIMIT 1000")
            .all(now.toISOString());
        for (const row of rows) {
            this.store.transaction(() => {
                const state = String(row.state);
                const event = state === "pending" ? "expire" : "recover_outcome_unknown";
                this.store.database
                    .prepare("UPDATE device_requests SET state = ?, parameters_json = '' WHERE request_id = ?")
                    .run(nextDeviceRequestState(state, event), String(row.request_id));
                recovered += 1;
            });
        }
        return recovered;
    }
    get(requestId) {
        return this.mapRequest(this.getRow(requestId));
    }
    /** Host adoption seam. Results are not audit content and must be explicitly ACKed. */
    readResult(requestId, claimId, now = new Date()) {
        const request = this.getRow(requestId);
        const receipt = this.store.database.prepare("SELECT 1 FROM claim_receipts WHERE request_id = ? AND claim_id = ?").get(requestId, claimId);
        if (receipt === undefined)
            throw new Error("OUTCOME_UNKNOWN");
        if (Date.parse(String(request.expires_at)) <= now.getTime()) {
            this.store.database.prepare("UPDATE device_requests SET result_json = '', parameters_json = '' WHERE request_id = ?").run(requestId);
            return undefined;
        }
        if (!request.result_json)
            return undefined;
        return this.store.openJson(String(request.result_json), `device-result:${requestId}:${claimId}`);
    }
    acknowledgeResult(requestId, claimId) {
        const receipt = this.store.database.prepare("SELECT 1 FROM claim_receipts WHERE request_id = ? AND claim_id = ?").get(requestId, claimId);
        if (receipt === undefined)
            throw new Error("OUTCOME_UNKNOWN");
        this.store.database.prepare("UPDATE device_requests SET result_json = '' WHERE request_id = ?").run(requestId);
        this.events.releaseDeviceRequest(requestId);
    }
    purgeTerminalPayloads(now = new Date()) {
        const result = this.store.database.prepare(`UPDATE device_requests SET result_json = '', parameters_json = '' WHERE request_id IN
      (SELECT request_id FROM device_requests WHERE expires_at <= ? AND (result_json != '' OR parameters_json != '') LIMIT 1000)`)
            .run(now.toISOString());
        return Number(result.changes);
    }
    getRow(requestId) {
        const row = this.store.database
            .prepare("SELECT * FROM device_requests WHERE request_id = ?")
            .get(requestId);
        if (row === undefined)
            throw new Error("OUTCOME_UNKNOWN");
        return row;
    }
    assertBinding(row, deviceId, pairingGeneration, grantRevision) {
        if (String(row.device_id) !== deviceId ||
            Number(row.pairing_generation) !== pairingGeneration) {
            throw new Error("PAIRING_GENERATION_STALE");
        }
        if (Number(row.grant_revision) !== grantRevision)
            throw new Error("GRANT_STALE");
    }
    expireIfDue(row, now) {
        if (Date.parse(String(row.expires_at)) > now.getTime())
            return false;
        const state = String(row.state);
        if (state !== "pending" && state !== "claimed" && state !== "cancel_requested")
            return false;
        const event = state === "pending" ? "expire" : "recover_outcome_unknown";
        this.store.database
            .prepare("UPDATE device_requests SET state = ?, parameters_json = '' WHERE request_id = ?")
            .run(nextDeviceRequestState(state, event), String(row.request_id));
        return true;
    }
    mapRequest(row) {
        return Object.freeze({
            requestId: String(row.request_id),
            deviceId: String(row.device_id),
            pairingGeneration: Number(row.pairing_generation),
            grantRevision: Number(row.grant_revision),
            risk: String(row.risk),
            state: String(row.state),
            expiresAt: String(row.expires_at),
        });
    }
    mapReceipt(row) {
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
