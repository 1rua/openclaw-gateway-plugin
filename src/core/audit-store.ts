import type { GatewayAccountStore } from "./account-store.js";

export type AuditRecord = Readonly<{
  eventType: string;
  actor: Readonly<Record<string, unknown>>;
  subject: Readonly<Record<string, unknown>>;
  correlationId: string;
  occurredAt: string;
}>;

const scrub = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(password|credential|secret|token|body|text|content|privateKey)/i.test(key))
      .map(([key, child]) => [key, scrub(child)]),
  );
};

export class AuditStore {
  constructor(private readonly store: GatewayAccountStore) {}

  append(record: AuditRecord): void {
    this.purge(new Date(record.occurredAt));
    this.store.database
      .prepare(`
        INSERT INTO audit_events(event_type, actor_json, subject_json, correlation_id, occurred_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        record.eventType,
        JSON.stringify(scrub(record.actor)),
        JSON.stringify(scrub(record.subject)),
        record.correlationId,
        record.occurredAt,
      );
  }

  purge(now = new Date(), limit = 1000): number {
    const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const result = this.store.database.prepare(`DELETE FROM audit_events WHERE audit_id IN
      (SELECT audit_id FROM audit_events WHERE occurred_at < ? ORDER BY audit_id LIMIT ?)`)
      .run(cutoff, limit) as { changes: number };
    return Number(result.changes);
  }

  list(): AuditRecord[] {
    return this.store.database
      .prepare(`
        SELECT event_type, actor_json, subject_json, correlation_id, occurred_at
        FROM audit_events
        ORDER BY audit_id ASC
      `)
      .all()
      .map((row: unknown) => {
        const record = row as Record<string, unknown>;
        return Object.freeze({
          eventType: String(record.event_type),
          actor: JSON.parse(String(record.actor_json)) as Readonly<Record<string, unknown>>,
          subject: JSON.parse(String(record.subject_json)) as Readonly<Record<string, unknown>>,
          correlationId: String(record.correlation_id),
          occurredAt: String(record.occurred_at),
        });
      });
  }
}
