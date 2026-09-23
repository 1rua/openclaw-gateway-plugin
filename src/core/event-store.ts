import { randomUUID } from "node:crypto";

import { createGatewayDispatchedValidator } from "../../../../gateway-contract/src/dispatched-schema-validator.js";
import fixtureRegistryJson from "../../../../gateway-contract/vectors/dispatched-schema-fixtures.json" with { type: "json" };

import type { GatewayAccountStore } from "./account-store.js";

export type GatewayEvent = Readonly<{
  eventId: string;
  eventType: string;
  correlationId: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
  expiresAt: string;
}>;

export type SequencedGatewayEvent = Readonly<GatewayEvent & { sequence: number }>;

type RawFixtureRegistry = {
  catalogEntries: Array<{ key: Record<string, unknown>; schema: unknown }>;
  bindingSets: Array<{
    bindings: Array<{ key: Record<string, unknown>; schemaSha256: string }>;
  }>;
};

/**
 * One process-wide dispatched validator built from the single shared fixture
 * registry. Fail closed (contract §9): every appended event payload must
 * validate against its bound sub-Schema, and an event type without a binding
 * is rejected instead of delivered unvalidated.
 */
const dispatchedEventValidator = (() => {
  const registry = fixtureRegistryJson as unknown as RawFixtureRegistry;
  const entries = registry.catalogEntries.map(({ key, schema }) => ({
    key,
    schema,
  })) as unknown as Parameters<typeof createGatewayDispatchedValidator>[0];
  const core: Array<Record<string, unknown>> = [];
  const device: Array<Record<string, unknown>> = [];
  for (const binding of registry.bindingSets[0]!.bindings) {
    const logical = binding.key;
    if (logical.kind === "device.request") {
      device.push({ ...logical, schemaSha256: binding.schemaSha256 });
    } else {
      core.push({ ...logical, schemaSha256: binding.schemaSha256 });
    }
  }
  const bindings = {
    core,
    device,
  } as unknown as Parameters<typeof createGatewayDispatchedValidator>[1];
  return createGatewayDispatchedValidator(entries, bindings);
})();

export class EventStore {
  constructor(
    private readonly store: GatewayAccountStore,
    private readonly retentionSeconds = 86_400,
  ) {}

  subscribe(listener: (event: Readonly<GatewayEvent & { sequence: number }>) => void): () => void {
    return this.store.subscribeCommittedEvents(listener);
  }

  append(input: Readonly<{
    eventType: string;
    correlationId: string;
    payload: Readonly<Record<string, unknown>>;
    now?: Date;
  }>): GatewayEvent {
    const now = input.now ?? new Date();
    let notification: Readonly<{ event: GatewayEvent; sequence: number }> | undefined;
    const event = this.store.transaction(() => {
      const counter = this.store.database.prepare("SELECT value FROM account_metadata WHERE key = 'event_sequence'")
        .get() as { value: string } | undefined;
      const sequence = Number(counter?.value ?? 0) + 1;
      const event: GatewayEvent = Object.freeze({
        eventId: `evt_${randomUUID()}`,
        eventType: input.eventType,
        correlationId: input.correlationId,
        occurredAt: now.toISOString(),
        payload: input.payload,
        expiresAt: new Date(now.getTime() + this.retentionSeconds * 1000).toISOString(),
      });
      const verified = dispatchedEventValidator.validate(
        { kind: "event", eventType: input.eventType },
        {
          correlationId: input.correlationId,
          occurredAt: event.occurredAt,
          payload: input.payload,
        },
      );
      if (!verified.ok) {
        console.warn(
          `[open_android] Rejected event append: eventType=${input.eventType} reason=${verified.errors?.join("; ") ?? "unknown"}`,
        );
        throw new Error("SCHEMA_INVALID");
      }
      this.store.database.prepare("UPDATE account_metadata SET value = ? WHERE key = 'event_sequence'")
        .run(String(sequence));
      this.store.database
        .prepare(`
          INSERT INTO events(event_id, event_sequence, event_type, correlation_id, occurred_at, payload_json, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          event.eventId,
          sequence,
          event.eventType,
          event.correlationId,
          event.occurredAt,
          JSON.stringify(event.payload),
          event.expiresAt,
        );
      notification = { event, sequence };
      return event;
    }, {
      onCommit: () => {
        if (notification === undefined) return;
        this.store.publishCommittedEvent({ ...notification.event, sequence: notification.sequence });
      },
    });
    return event;
  }

  readAfter(cursor: string | null, now = new Date()): GatewayEvent[] {
    return this.readAfterWithSequence(cursor, now).map(({ sequence: _sequence, ...event }) => event);
  }

  sequenceAfter(cursor: string | null, now = new Date()): number {
    if (cursor !== null) {
      const row = this.store.database
        .prepare("SELECT expires_at, event_sequence FROM events WHERE event_id = ?")
        .get(cursor) as { expires_at: string; event_sequence: number } | undefined;
      if (row === undefined || Date.parse(row.expires_at) <= now.getTime()) {
        throw new Error("CURSOR_EXPIRED");
      }
      return Number(row.event_sequence);
    }
    return 0;
  }

  readAfterWithSequence(cursor: string | null, now = new Date()): SequencedGatewayEvent[] {
    const cursorSequence = this.sequenceAfter(cursor, now);
    const rows = this.store.database
      .prepare(`SELECT * FROM events WHERE expires_at > ? AND event_sequence > ? ORDER BY event_sequence ASC`)
      .all(now.toISOString(), cursorSequence);
    return rows.map((raw: unknown) => {
      const row = raw as Record<string, unknown>;
      return Object.freeze({ ...this.mapEvent(row), sequence: Number(row.event_sequence) });
    });
  }

  private mapEvent(row: Record<string, unknown>): GatewayEvent {
    return Object.freeze({
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      correlationId: String(row.correlation_id),
      occurredAt: String(row.occurred_at),
      payload: JSON.parse(String(row.payload_json)) as Readonly<Record<string, unknown>>,
      expiresAt: String(row.expires_at),
    });
  }
}
