import { DatabaseSync } from "node:sqlite";

import { type AccountPaths, ensureAccountDirectories } from "./account-paths.js";

export type GatewayAccountStore = Readonly<{
  database: DatabaseSync;
  transaction: <T>(work: () => T) => T;
  close: () => void;
}>;

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

    CREATE TABLE IF NOT EXISTS access_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      installation_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
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
      event_type TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY NOT NULL,
      client_attachment_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      content_path TEXT,
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
      attachment_ids_json TEXT NOT NULL,
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

const ensureMetadata = (database: DatabaseSync, key: string, value: string): void => {
  database
    .prepare("INSERT OR IGNORE INTO account_metadata(key, value) VALUES (?, ?)")
    .run(key, value);
};

export const openAccountStore = (paths: AccountPaths): GatewayAccountStore => {
  ensureAccountDirectories(paths);
  const database = new DatabaseSync(paths.database);
  let transactionDepth = 0;
  migrate(database);
  ensureMetadata(database, "master_key_ref", `host-secret:${paths.root.split("/").at(-1) ?? "account"}`);
  ensureMetadata(database, "gateway_identity_ref", "spki_initial");
  return Object.freeze({
    database,
    transaction: <T>(work: () => T): T => {
      if (transactionDepth > 0) return work();
      database.exec("BEGIN IMMEDIATE");
      transactionDepth += 1;
      try {
        const result = work();
        database.exec("COMMIT");
        transactionDepth -= 1;
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Some security paths commit their revocation evidence before returning
          // an error so the failure itself cannot roll back the protection.
        }
        transactionDepth -= 1;
        throw error;
      }
    },
    close: () => database.close(),
  });
};
