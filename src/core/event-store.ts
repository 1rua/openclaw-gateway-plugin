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

  append(input: Readonly<{
    eventType: string;
    correlationId: string;
    payload: Readonly<Record<string, unknown>>;
    now?: Date;
  }>): GatewayEvent {
    const now = input.now ?? new Date();
    const event = Object.freeze({
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
    this.store.database
      .prepare(`
        INSERT INTO events(event_id, event_type, correlation_id, occurred_at, payload_json, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventId,
        event.eventType,
        event.correlationId,
        event.occurredAt,
        JSON.stringify(event.payload),
        event.expiresAt,
      );
    return event;
  }

  readAfter(cursor: string | null, now = new Date()): GatewayEvent[] {
    if (cursor !== null) {
      const row = this.store.database
        .prepare("SELECT expires_at FROM events WHERE event_id = ?")
        .get(cursor) as { expires_at: string } | undefined;
      if (row === undefined || Date.parse(row.expires_at) <= now.getTime()) {
        throw new Error("CURSOR_EXPIRED");
      }
    }
    const rows =
      cursor === null
        ? this.store.database.prepare("SELECT * FROM events WHERE expires_at > ? ORDER BY occurred_at ASC, event_id ASC").all(now.toISOString())
        : this.store.database
            .prepare(`
              SELECT * FROM events
              WHERE expires_at > ?
                AND (occurred_at, event_id) > (
                  SELECT occurred_at, event_id FROM events WHERE event_id = ?
                )
              ORDER BY occurred_at ASC, event_id ASC
            `)
            .all(now.toISOString(), cursor);
    return rows.map((row: unknown) => this.mapEvent(row as Record<string, unknown>));
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
