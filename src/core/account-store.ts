import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { type AccountPaths, ensureAccountDirectories } from "./account-paths.js";
import { AccountPayloadCipher } from "./payload-cipher.js";

export type TransactionHooks = Readonly<{
  onCommit?: () => void;
  onRollback?: () => void;
}>;

export type CommittedEventNotification = Readonly<{
  eventId: string;
  eventType: string;
  correlationId: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
  expiresAt: string;
  sequence: number;
}>;

export type GatewayAccountStore = Readonly<{
  database: DatabaseSync;
  transaction: <T>(work: () => T, hooks?: TransactionHooks) => T;
  subscribeCommittedEvents: (listener: (event: CommittedEventNotification) => void) => () => void;
  publishCommittedEvent: (event: CommittedEventNotification) => void;
  close: () => void;
  sealString: (value: string, purpose: string) => string;
  openString: (value: string, purpose: string) => string;
  sealJson: (value: unknown, purpose: string) => string;
  openJson: (value: string, purpose: string) => unknown;
  /**
   * Test seam for the commit-uncertainty path: setting `value` makes the next
   * `transaction` commit fail with `OUTCOME_UNKNOWN` — the code a caller gets
   * when it cannot know whether its commit landed. Production code never
   * touches this field.
   */
  readonly failNextCommit: { value: boolean };
}>;

type EventHub = { listeners: Set<(event: CommittedEventNotification) => void> };
const committedEventHubs = new Map<string, EventHub>();

const eventHubKey = (databasePath: string): string => resolve(databasePath);

const migrate = (database: DatabaseSync): void => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS account_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_credentials (
      credential_hash TEXT PRIMARY KEY NOT NULL,
      installation_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      replaced_by_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS request_nonces (
      device_id TEXT NOT NULL, nonce_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
      PRIMARY KEY (device_id, nonce_hash)
    );
    CREATE INDEX IF NOT EXISTS request_nonces_expiry ON request_nonces(expires_at);
    CREATE TABLE IF NOT EXISTS access_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      installation_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      access_token_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS device_keys (
      device_id TEXT PRIMARY KEY NOT NULL,
      installation_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      pairing_generation INTEGER NOT NULL DEFAULT 1,
      grant_revision INTEGER NOT NULL DEFAULT 1,
      registered_at TEXT NOT NULL
    );

    -- Only a digest of the account password is stored, so the Gateway can never
    -- read the password back and an account without one cannot be logged into.
    CREATE TABLE IF NOT EXISTS account_credentials (
      credential_id TEXT PRIMARY KEY NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_ledger (
      device_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (device_id, request_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY NOT NULL,
      event_sequence INTEGER UNIQUE,
      event_type TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY NOT NULL,
      client_attachment_id TEXT NOT NULL,
      client_attachment_key TEXT,
      owner_device_id TEXT,
      owner_pairing_generation INTEGER,
      storage_revision INTEGER NOT NULL DEFAULT 0,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      content_path TEXT,
      uploaded_size_bytes INTEGER,
      uploaded_sha256 TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      delivered_at TEXT,
      acknowledged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY NOT NULL,
      client_conversation_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      attachment_ids_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      status_revision INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      dispatchable INTEGER NOT NULL DEFAULT 1,
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_until TEXT,
      delivered_at TEXT,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
    );

    CREATE TABLE IF NOT EXISTS device_requests (
      request_id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      pairing_generation INTEGER NOT NULL,
      grant_revision INTEGER NOT NULL,
      risk TEXT NOT NULL,
      state TEXT NOT NULL,
      capability_json TEXT NOT NULL,
      provider_json TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claim_receipts (
      claim_id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      pairing_generation INTEGER NOT NULL,
      grant_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES device_requests(request_id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identity_rotation_receipts (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      previous_identity_ref TEXT NOT NULL,
      next_identity_ref TEXT NOT NULL,
      proof_hash TEXT NOT NULL,
      master_key_ref TEXT NOT NULL,
      rotated_at TEXT NOT NULL,
      correlation_id TEXT NOT NULL
    );
  `);
};

const ensureColumn = (database: DatabaseSync, table: string, column: string, definition: string): void => {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

const migrateAttachmentSchema = (database: DatabaseSync): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    ensureColumn(database, "attachments", "client_attachment_key", "TEXT");
    ensureColumn(database, "attachments", "owner_device_id", "TEXT");
    ensureColumn(database, "attachments", "owner_pairing_generation", "INTEGER");
    ensureColumn(database, "attachments", "storage_revision", "INTEGER NOT NULL DEFAULT 0");
    ensureMetadata(database, "attachment_storage_format", "2");
    const attachmentFormat = database.prepare("SELECT value FROM account_metadata WHERE key = 'attachment_storage_format'")
      .get() as { value: string } | undefined;
    if (attachmentFormat?.value !== "2") throw new Error("ATTACHMENT_STORAGE_VERSION_UNSUPPORTED");

    const rows = database.prepare(`
      SELECT attachment_id, client_attachment_id, client_attachment_key FROM attachments
      ORDER BY created_at ASC, attachment_id ASC
    `).all() as Array<{ attachment_id: string; client_attachment_id: string; client_attachment_key: string | null }>;
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.client_attachment_id, (counts.get(row.client_attachment_id) ?? 0) + 1);
    for (const row of rows) {
      if (row.client_attachment_key !== null && row.client_attachment_key.length > 0) continue;
      const key = counts.get(row.client_attachment_id) === 1
        ? `client:${row.client_attachment_id}`
        : `legacy:${row.attachment_id}`;
      database.prepare("UPDATE attachments SET client_attachment_key = ? WHERE attachment_id = ?")
        .run(key, row.attachment_id);
    }
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS attachments_client_attachment_key_unique ON attachments(client_attachment_key)");
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS attachments_require_pairing_identity
      BEFORE INSERT ON attachments
      WHEN (SELECT value FROM account_metadata WHERE key = 'attachment_storage_format') = '2'
        AND (NEW.owner_device_id IS NULL OR NEW.owner_device_id = '' OR NEW.owner_pairing_generation IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'ATTACHMENT_PAIRING_BINDING_REQUIRED');
      END;
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS attachments_require_storage_revision
      BEFORE UPDATE ON attachments
      WHEN (SELECT value FROM account_metadata WHERE key = 'attachment_storage_format') = '2'
        AND NEW.storage_revision != OLD.storage_revision + 1
      BEGIN
        SELECT RAISE(ABORT, 'ATTACHMENT_STORAGE_VERSION_UNSUPPORTED');
      END;
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS attachments_require_delete_authorization
      BEFORE DELETE ON attachments
      WHEN (SELECT value FROM account_metadata WHERE key = 'attachment_storage_format') = '2'
        AND COALESCE((SELECT value FROM account_metadata WHERE key = 'attachment_delete_authorization'), '') != 'active'
      BEGIN
        SELECT RAISE(ABORT, 'ATTACHMENT_STORAGE_VERSION_UNSUPPORTED');
      END;
    `);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve original migration failure */ }
    database.close();
    throw error;
  }
};

const migrateEventSequence = (database: DatabaseSync): void => {
  ensureColumn(database, "events", "event_sequence", "INTEGER");
  const rows = database.prepare("SELECT event_id FROM events WHERE event_sequence IS NULL ORDER BY occurred_at ASC, event_id ASC")
    .all() as Array<{ event_id: string }>;
  let next = Number((database.prepare("SELECT COALESCE(MAX(event_sequence), 0) AS max_sequence FROM events")
    .get() as { max_sequence: number }).max_sequence);
  for (const row of rows) {
    next += 1;
    database.prepare("UPDATE events SET event_sequence = ? WHERE event_id = ?").run(next, row.event_id);
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_sequence_unique ON events(event_sequence)");
};

const ensureMetadata = (database: DatabaseSync, key: string, value: string): void => {
  database
    .prepare("INSERT OR IGNORE INTO account_metadata(key, value) VALUES (?, ?)")
    .run(key, value);
};

export const openAccountStore = (paths: AccountPaths, payload?: Readonly<{ accountId: string; masterKey?: Uint8Array; reference: string }>): GatewayAccountStore => {
  ensureAccountDirectories(paths);
  const database = new DatabaseSync(paths.database);
  let transactionDepth = 0;
  let activeHooks: {
    onCommit: Array<() => void>;
    onRollback: Array<() => void>;
  } | undefined;

  const addHooks = (hooks?: TransactionHooks): void => {
    if (hooks?.onCommit !== undefined) activeHooks?.onCommit.push(hooks.onCommit);
    if (hooks?.onRollback !== undefined) activeHooks?.onRollback.push(hooks.onRollback);
  };

  const runBestEffort = (hooks: readonly (() => void)[]): void => {
    for (const hook of hooks) {
      try {
        hook();
      } catch {
        // The database decision is already durable or rolled back. A hook failure
        // remains retryable through the attachment staging reconciliation scan.
      }
    }
  };

  migrate(database);
  migrateAttachmentSchema(database);
  ensureColumn(database, "attachments", "uploaded_size_bytes", "INTEGER");
  ensureColumn(database, "attachments", "uploaded_sha256", "TEXT");
  ensureColumn(database, "messages", "body", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "device_requests", "result_json", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "messages", "status", "TEXT NOT NULL DEFAULT 'queued'");
  ensureColumn(database, "messages", "status_revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "messages", "error_code", "TEXT");
  // Legacy message rows predate durable Agent delivery and contain no body;
  // only newly accepted messages may enter the outbox after upgrade.
  ensureColumn(database, "messages", "dispatchable", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "messages", "dispatch_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "messages", "next_attempt_at", "TEXT");
  ensureColumn(database, "messages", "lease_until", "TEXT");
  ensureColumn(database, "messages", "delivered_at", "TEXT");
  ensureColumn(database, "messages", "expires_at", "TEXT");
  migrateEventSequence(database);
  ensureMetadata(database, "master_key_ref", "unconfigured");
  ensureMetadata(database, "gateway_identity_ref", "spki_initial");
  // Contract §12: every re-pair, key rotation or recovery produces a *higher*
  // pairing generation. The counter has to outlive the `device_keys` row it
  // seeds, because 解除配对 deletes that row (§13) — keeping it only there
  // would let the next login silently restart the generation at 1.
  ensureMetadata(database, "pairing_generation", "1");
  ensureMetadata(database, "event_sequence", String((database.prepare("SELECT COALESCE(MAX(event_sequence), 0) AS sequence FROM events")
    .get() as { sequence: number }).sequence));
  database.exec("PRAGMA secure_delete = ON");
  const cipher = new AccountPayloadCipher(payload?.masterKey, payload?.accountId ?? "");
  const format = database.prepare("SELECT value FROM account_metadata WHERE key = 'payload_storage_format'").get() as { value: string } | undefined;
  if (format !== undefined && format.value !== "1") { database.close(); cipher.close(); throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE"); }
  if (cipher.available && format === undefined) {
    const previous = database.prepare("SELECT value FROM account_metadata WHERE key = 'master_key_ref'").get() as { value: string };
    if (previous.value !== "unconfigured" && !previous.value.startsWith("host-secret:") && previous.value !== payload!.reference) {
      database.close(); cipher.close(); throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, idColumn, column, purpose] of [
        ["messages", "message_id", "body", "message"], ["events", "event_id", "payload_json", "event"],
        ["device_requests", "request_id", "parameters_json", "device-request"],
      ] as const) {
        for (const row of database.prepare(`SELECT ${idColumn} AS id, ${column} AS value FROM ${table}`).all() as Array<{ id: string; value: string }>) {
          if (row.value !== "") database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`).run(cipher.seal(row.value, `${purpose}:${row.id}`), row.id);
        }
      }
      for (const row of database.prepare("SELECT device_id, request_id, outcome_json FROM idempotency_ledger").all() as Array<{ device_id: string; request_id: string; outcome_json: string }>) {
        database.prepare("UPDATE idempotency_ledger SET outcome_json = ? WHERE device_id = ? AND request_id = ?")
          .run(cipher.seal(row.outcome_json, `idempotency:${row.device_id}:${row.request_id}`), row.device_id, row.request_id);
      }
      database.prepare("INSERT INTO account_metadata(key,value) VALUES ('payload_storage_format','1')").run();
      database.prepare("INSERT INTO account_metadata(key,value) VALUES ('payload_scrub_pending','1')").run();
      database.prepare("UPDATE account_metadata SET value = ? WHERE key = 'master_key_ref'").run(payload!.reference);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      database.close(); cipher.close(); throw error;
    }
  }
  if (cipher.available && database.prepare("SELECT 1 FROM account_metadata WHERE key = 'payload_scrub_pending'").get() !== undefined) {
    try {
      const reference = database.prepare("SELECT value FROM account_metadata WHERE key = 'master_key_ref'").get() as { value: string };
      if (reference.value !== payload!.reference) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
      const checkpoint = () => {
        const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
        if (result.busy !== 0) throw new Error("PAYLOAD_MIGRATION_BUSY");
      };
      checkpoint();
      database.exec("VACUUM");
      checkpoint();
      database.prepare("DELETE FROM account_metadata WHERE key = 'payload_scrub_pending'").run();
    } catch (error) {
      database.close(); cipher.close(); throw error;
    }
  }
  const hubKey = eventHubKey(paths.database);
  const failNextCommit = { value: false };
  return Object.freeze({
    database,
    sealString: (value, purpose) => cipher.seal(value, purpose),
    openString: (value, purpose) => cipher.open(value, purpose),
    sealJson: (value, purpose) => cipher.seal(JSON.stringify(value), purpose),
    openJson: (value, purpose) => JSON.parse(cipher.open(value, purpose)) as unknown,
    failNextCommit,
    subscribeCommittedEvents: (listener) => {
      let hub = committedEventHubs.get(hubKey);
      if (hub === undefined) {
        hub = { listeners: new Set() };
        committedEventHubs.set(hubKey, hub);
      }
      hub.listeners.add(listener);
      return () => {
        const current = committedEventHubs.get(hubKey);
        if (current === undefined) return;
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && committedEventHubs.get(hubKey) === current) {
          committedEventHubs.delete(hubKey);
        }
      };
    },
    publishCommittedEvent: (event) => {
      const hub = committedEventHubs.get(hubKey);
      if (hub === undefined) return;
      for (const listener of hub.listeners) {
        try { listener(event); } catch { /* one subscriber cannot block committed Gateway work */ }
      }
    },
    transaction: <T>(work: () => T, hooks?: TransactionHooks): T => {
      if (transactionDepth > 0) {
        const result = work();
        addHooks(hooks);
        return result;
      }
      database.exec("BEGIN IMMEDIATE");
      transactionDepth += 1;
      activeHooks = { onCommit: [], onRollback: [] };
      addHooks(hooks);
      try {
        const result = work();
        if (failNextCommit.value) {
          failNextCommit.value = false;
          // The outcome of this commit is unknowable, so every statement of
          // the transaction is rolled back and the caller is told exactly
          // that — never handed a success that may not have happened.
          throw new Error("OUTCOME_UNKNOWN");
        }
        database.exec("COMMIT");
        transactionDepth -= 1;
        const committedHooks = activeHooks.onCommit;
        activeHooks = undefined;
        runBestEffort(committedHooks);
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Some security paths commit their revocation evidence before returning
          // an error so the failure itself cannot roll back the protection.
        }
        transactionDepth -= 1;
        const rollbackHooks = [...(activeHooks?.onRollback ?? [])].reverse();
        activeHooks = undefined;
        runBestEffort(rollbackHooks);
        throw error;
      }
    },
    close: () => { cipher.close(); database.close(); },
  });
};
