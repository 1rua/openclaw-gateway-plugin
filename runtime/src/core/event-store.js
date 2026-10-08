import { randomUUID } from "node:crypto";
import { createGatewayDispatchedValidator } from "../../gateway-contract/src/dispatched-schema-validator.js";
import coreRegistryJson from "../../gateway-contract/core-dispatched-schemas.json" with { type: "json" };
export const coreCatalog = coreRegistryJson.catalogEntries;
export const coreBindings = coreRegistryJson.bindings.map(binding => ({ ...binding.key, schemaSha256: binding.schemaSha256 }));
const dispatchedEventValidator = createGatewayDispatchedValidator(coreCatalog, { core: coreBindings, device: [] });
export class EventStore {
    store;
    retentionSeconds;
    constructor(store, retentionSeconds = 86_400) {
        this.store = store;
        this.retentionSeconds = retentionSeconds;
    }
    subscribe(listener) {
        return this.store.subscribeCommittedEvents(listener);
    }
    append(input) {
        const now = input.now ?? new Date();
        this.purgeExpired(now);
        let notification;
        const event = this.store.transaction(() => {
            const counter = this.store.database.prepare("SELECT value FROM account_metadata WHERE key = 'event_sequence'")
                .get();
            const sequence = Number(counter?.value ?? 0) + 1;
            const event = Object.freeze({
                eventId: `evt_${randomUUID()}`,
                eventType: input.eventType,
                correlationId: input.correlationId,
                occurredAt: now.toISOString(),
                payload: input.payload,
                expiresAt: new Date(Math.min(now.getTime() + this.retentionSeconds * 1000, input.eventType === "device.requested" && typeof input.payload.expiresAt === "string"
                    ? Date.parse(input.payload.expiresAt) : Infinity)).toISOString(),
            });
            const verified = dispatchedEventValidator.validate({ kind: "event", eventType: input.eventType }, {
                correlationId: input.correlationId,
                occurredAt: event.occurredAt,
                payload: input.payload,
            });
            if (!verified.ok) {
                console.warn(`[open_android] Rejected event append: eventType=${input.eventType} reason=${verified.errors?.join("; ") ?? "unknown"}`);
                throw new Error("SCHEMA_INVALID");
            }
            this.store.database.prepare("UPDATE account_metadata SET value = ? WHERE key = 'event_sequence'")
                .run(String(sequence));
            this.store.database
                .prepare(`
          INSERT INTO events(event_id, event_sequence, event_type, correlation_id, occurred_at, payload_json, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
                .run(event.eventId, sequence, event.eventType, event.correlationId, event.occurredAt, this.store.sealJson(event.payload, `event:${event.eventId}`), event.expiresAt);
            notification = { event, sequence };
            return event;
        }, {
            onCommit: () => {
                if (notification === undefined)
                    return;
                this.store.publishCommittedEvent({ ...notification.event, sequence: notification.sequence });
            },
        });
        return event;
    }
    readAfter(cursor, now = new Date()) {
        return this.readAfterWithSequence(cursor, now).map(({ sequence: _sequence, ...event }) => event);
    }
    /** Release every encrypted transport copy while keeping the event cursor valid. */
    releaseDeviceRequest(requestId) {
        for (const raw of this.store.database.prepare("SELECT event_id,payload_json FROM events WHERE event_type='device.requested'").iterate()) {
            const row = raw;
            const payload = this.store.openJson(row.payload_json, `event:${row.event_id}`);
            if (payload.requestId !== requestId || !("parameters" in payload))
                continue;
            payload.parameters = {};
            this.store.database.prepare("UPDATE events SET payload_json=? WHERE event_id=?").run(this.store.sealJson(payload, `event:${row.event_id}`), row.event_id);
        }
    }
    sequenceAfter(cursor, now = new Date()) {
        this.purgeExpired(now);
        if (cursor !== null) {
            const row = this.store.database
                .prepare("SELECT expires_at, event_sequence FROM events WHERE event_id = ?")
                .get(cursor);
            if (row === undefined || Date.parse(row.expires_at) <= now.getTime()) {
                throw new Error("CURSOR_EXPIRED");
            }
            return Number(row.event_sequence);
        }
        return 0;
    }
    purgeExpired(now = new Date(), limit = 1000) {
        // Upgrade pre-policy events in bounded batches. Their payload's resource
        // expiry was always authoritative, even when the old event TTL was 24h.
        const marker = this.store.database.prepare("SELECT value FROM account_metadata WHERE key='event-body-policy-v2'").get();
        const legacy = this.store.database.prepare("SELECT event_id,event_sequence,payload_json,expires_at FROM events WHERE event_type='device.requested' AND event_sequence>? ORDER BY event_sequence LIMIT ?")
            .all(Number(marker?.value ?? 0), limit);
        for (const row of legacy) {
            const payload = this.store.openJson(row.payload_json, `event:${row.event_id}`);
            const expiry = typeof payload.expiresAt === "string" && Number.isFinite(Date.parse(payload.expiresAt)) ? payload.expiresAt : row.expires_at;
            const request = this.store.database.prepare("SELECT parameters_json FROM device_requests WHERE request_id=?").get(String(payload.requestId));
            if (!request || request.parameters_json === "")
                payload.parameters = {};
            this.store.database.prepare("UPDATE events SET payload_json=?,expires_at=? WHERE event_id=?")
                .run(this.store.sealJson(payload, `event:${row.event_id}`), new Date(Math.min(Date.parse(expiry), Date.parse(row.expires_at))).toISOString(), row.event_id);
        }
        if (legacy.length)
            this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES ('event-body-policy-v2',?)").run(String(legacy.at(-1).event_sequence));
        const result = this.store.database.prepare(`DELETE FROM events WHERE event_id IN
      (SELECT event_id FROM events WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
            .run(now.toISOString(), limit);
        return Number(result.changes);
    }
    readAfterWithSequence(cursor, now = new Date()) {
        const cursorSequence = this.sequenceAfter(cursor, now);
        const rows = this.store.database
            .prepare(`SELECT * FROM events WHERE expires_at > ? AND event_sequence > ? ORDER BY event_sequence ASC`)
            .all(now.toISOString(), cursorSequence);
        return rows.map((raw) => {
            const row = raw;
            return Object.freeze({ ...this.mapEvent(row), sequence: Number(row.event_sequence) });
        });
    }
    mapEvent(row) {
        return Object.freeze({
            eventId: String(row.event_id),
            eventType: String(row.event_type),
            correlationId: String(row.correlation_id),
            occurredAt: String(row.occurred_at),
            payload: this.store.openJson(String(row.payload_json), `event:${row.event_id}`),
            expiresAt: String(row.expires_at),
        });
    }
}
